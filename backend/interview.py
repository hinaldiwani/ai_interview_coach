import json
import time
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from .database import get_db
from .auth import get_current_user_from_token
from .question_generator import generate_questions, get_question_count_by_difficulty
from .evaluator import evaluate_answer

router = APIRouter(prefix="/api/interviews", tags=["interviews"])

class CreateInterviewReq(BaseModel):
    role: str
    experience: str
    interview_type: str
    difficulty: str
    total_questions: Optional[int] = None

DURATION_MATRIX_SECONDS = {
    "Technical": {
        "Easy": 120,      # 2m 0s
        "Medium": 180,    # 3m 0s
        "Hard": 240       # 4m 0s
    },
    "HR": {
        "Easy": 90,       # 1m 30s
        "Medium": 120,    # 2m 0s
        "Hard": 180       # 3m 0s
    },
    "Behavioral": {
        "Easy": 180,      # 3m 0s
        "Medium": 240,    # 4m 0s
        "Hard": 300       # 5m 0s
    },
    "Mixed": {
        "Easy": 150,      # 2m 30s
        "Medium": 180,    # 3m 0s
        "Hard": 240       # 4m 0s
    }
}

def get_duration_per_question(interview_type: str, difficulty: str) -> int:
    t = (interview_type or "Technical").strip().title()
    d = (difficulty or "Medium").strip().title()
    if t not in DURATION_MATRIX_SECONDS:
        t = "Technical"
    if d not in DURATION_MATRIX_SECONDS[t]:
        d = "Medium"
    return DURATION_MATRIX_SECONDS[t][d]

class SubmitAnswerReq(BaseModel):
    question_id: int
    user_answer: str

@router.post("")
def create_interview(req: CreateInterviewReq, current_user: dict = Depends(get_current_user_from_token)):
    user_id = int(current_user["sub"])
    diff_normalized = (req.difficulty or "Medium").strip().title()

    # Enforce mandatory question counts per specification:
    # Easy -> 10 questions, Medium -> 20 questions, Hard -> 30 questions
    target_questions = get_question_count_by_difficulty(diff_normalized)

    # 1. Generate questions and answers strictly from Gemini API
    try:
        questions = generate_questions(
            role=req.role,
            experience=req.experience,
            interview_type=req.interview_type,
            difficulty=diff_normalized,
            total_questions=target_questions
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate questions via Gemini API: {str(e)}")

    if not questions:
        raise HTTPException(status_code=500, detail="Gemini API did not return any questions.")

    actual_count = len(questions)

    # 2. Persist interview and generated questions with ideal answers in MySQL
    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """INSERT INTO interviews 
            (user_id, role, experience, interview_type, difficulty, total_questions, status)
            VALUES (%s, %s, %s, %s, %s, %s, 'in_progress')""",
            (user_id, req.role, req.experience, req.interview_type, diff_normalized, actual_count)
        )
        interview_id = cursor.lastrowid

        # Fetch created_at timestamp in millisecond epoch
        cursor.execute("SELECT started_at, UNIX_TIMESTAMP(started_at) AS start_ts FROM interviews WHERE id = %s", (interview_id,))
        row = cursor.fetchone()
        if row and row.get("start_ts"):
            start_timestamp = int(row["start_ts"] * 1000)
        else:
            start_timestamp = int(time.time() * 1000)

        # Calculate total duration in seconds
        sec_per_q = get_duration_per_question(req.interview_type, diff_normalized)
        duration_seconds = actual_count * sec_per_q

        saved_questions = []
        for q in questions:
            q_type = q.get("question_type", req.interview_type)
            cursor.execute(
                """INSERT INTO questions
                (interview_id, question_text, question_type, difficulty, question_order, ideal_answer, key_concepts)
                VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    interview_id,
                    q["question_text"],
                    q_type,
                    q.get("difficulty", diff_normalized),
                    q.get("question_order", 1),
                    q.get("ideal_answer", ""),
                    q.get("key_concepts", "")
                )
            )
            q_id = cursor.lastrowid
            saved_questions.append({
                "id": q_id,
                "question_order": q["question_order"],
                "question_text": q["question_text"],
                "question_type": q_type,
                "difficulty": q.get("difficulty", diff_normalized),
                "ideal_answer": q.get("ideal_answer", ""),
                "key_concepts": q.get("key_concepts", "")
            })
    finally:
        conn.close()

    return {
        "interview_id": interview_id,
        "role": req.role,
        "experience": req.experience,
        "interview_type": req.interview_type,
        "difficulty": diff_normalized,
        "total_questions": actual_count,
        "duration_seconds": duration_seconds,
        "start_timestamp": start_timestamp,
        "questions": saved_questions
    }

@router.get("/{interview_id}")
def get_interview_session(interview_id: int, current_user: dict = Depends(get_current_user_from_token)):
    user_id = int(current_user["sub"])
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT *, UNIX_TIMESTAMP(started_at) AS start_ts FROM interviews WHERE id = %s AND user_id = %s", (interview_id, user_id))
    interview = cursor.fetchone()
    if not interview:
        conn.close()
        raise HTTPException(status_code=404, detail="Interview not found.")

    cursor.execute(
        """SELECT id, question_order, question_text, question_type, difficulty, ideal_answer, key_concepts 
           FROM questions WHERE interview_id = %s ORDER BY question_order ASC""",
        (interview_id,)
    )
    questions = cursor.fetchall()
    conn.close()

    sec_per_q = get_duration_per_question(interview.get("interview_type"), interview.get("difficulty"))
    duration_seconds = (interview.get("total_questions") or 5) * sec_per_q
    
    if interview.get("start_ts"):
        start_timestamp = int(interview["start_ts"] * 1000)
    else:
        start_timestamp = int(time.time() * 1000)

    return {
        "interview_id": interview["id"],
        "role": interview["role"],
        "experience": interview["experience"],
        "interview_type": interview["interview_type"],
        "difficulty": interview["difficulty"],
        "total_questions": interview["total_questions"],
        "duration_seconds": duration_seconds,
        "start_timestamp": start_timestamp,
        "status": interview["status"],
        "termination_reason": interview.get("termination_reason"),
        "questions": questions
    }

@router.post("/{interview_id}/answer")
def submit_answer(interview_id: int, req: SubmitAnswerReq, current_user: dict = Depends(get_current_user_from_token)):
    conn = get_db()
    cursor = conn.cursor()
    user_id = int(current_user["sub"])

    cursor.execute("SELECT id, role, difficulty, interview_type FROM interviews WHERE id = %s AND user_id = %s", (interview_id, user_id))
    interview = cursor.fetchone()
    if not interview:
        conn.close()
        raise HTTPException(status_code=404, detail="Interview not found.")

    cursor.execute("SELECT id, question_text, question_type, ideal_answer, key_concepts FROM questions WHERE id = %s AND interview_id = %s", (req.question_id, interview_id))
    question = cursor.fetchone()
    if not question:
        conn.close()
        raise HTTPException(status_code=404, detail="Question not found.")

    # Evaluate Answer with category awareness
    eval_res = evaluate_answer(
        question_text=question["question_text"],
        user_answer=req.user_answer,
        ideal_answer=question["ideal_answer"] or "",
        key_concepts=question["key_concepts"] or "",
        role=interview["role"],
        difficulty=interview["difficulty"],
        question_type=question.get("question_type") or interview.get("interview_type") or "Technical"
    )

    # Save/Update Answer
    cursor.execute("SELECT id FROM answers WHERE interview_id = %s AND question_id = %s", (interview_id, req.question_id))
    existing_ans = cursor.fetchone()

    if existing_ans:
        answer_id = existing_ans["id"]
        cursor.execute("UPDATE answers SET user_answer = %s WHERE id = %s", (req.user_answer, answer_id))
        cursor.execute(
            """UPDATE evaluations SET
            score = %s, correctness_score = %s, relevance_score = %s, technical_score = %s,
            clarity_score = %s, completeness_score = %s, feedback = %s, ideal_answer = %s,
            improvement_suggestion = %s WHERE answer_id = %s""",
            (
                eval_res["score"], eval_res["correctness_score"], eval_res["relevance_score"],
                eval_res["technical_score"], eval_res["clarity_score"], eval_res["completeness_score"],
                eval_res["feedback"], eval_res["ideal_answer"], eval_res["improvement_suggestion"], answer_id
            )
        )
    else:
        cursor.execute("INSERT INTO answers (interview_id, question_id, user_answer) VALUES (%s, %s, %s)", (interview_id, req.question_id, req.user_answer))
        answer_id = cursor.lastrowid
        cursor.execute(
            """INSERT INTO evaluations
            (answer_id, score, correctness_score, relevance_score, technical_score, clarity_score, completeness_score, feedback, ideal_answer, improvement_suggestion)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                answer_id, eval_res["score"], eval_res["correctness_score"], eval_res["relevance_score"],
                eval_res["technical_score"], eval_res["clarity_score"], eval_res["completeness_score"],
                eval_res["feedback"], eval_res["ideal_answer"], eval_res["improvement_suggestion"]
            )
        )

    conn.close()
    return {"message": "Answer evaluated successfully.", "evaluation": eval_res}

@router.post("/{interview_id}/complete")
def complete_interview(interview_id: int, current_user: dict = Depends(get_current_user_from_token)):
    user_id = int(current_user["sub"])
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM interviews WHERE id = %s AND user_id = %s", (interview_id, user_id))
    interview = cursor.fetchone()
    if not interview:
        conn.close()
        raise HTTPException(status_code=404, detail="Interview not found.")

    # Idempotency check: if already completed, return existing results
    if interview.get("status") == "completed":
        cursor.execute("SELECT * FROM interview_results WHERE interview_id = %s ORDER BY id DESC LIMIT 1", (interview_id,))
        existing_res = cursor.fetchone()
        conn.close()
        if existing_res:
            return {
                "interview_id": interview_id,
                "overall_score": existing_res["overall_score"],
                "performance_category": existing_res["performance_category"],
                "technical_score": existing_res["technical_score"],
                "correctness_score": existing_res["correctness_score"],
                "communication_score": existing_res["communication_score"],
                "completeness_score": existing_res["completeness_score"],
                "strengths": existing_res["strengths"],
                "weak_areas": existing_res["weak_areas"],
                "recommendations": existing_res["recommendations"]
            }

    cursor.execute("""
        SELECT a.*, e.score, e.correctness_score, e.relevance_score, e.technical_score,
               e.clarity_score, e.completeness_score, e.improvement_suggestion, e.feedback
        FROM answers a
        JOIN evaluations e ON a.id = e.answer_id
        WHERE a.interview_id = %s
    """, (interview_id,))
    evals = cursor.fetchall()

    if not evals:
        overall_score = tech_score = correctness_score = comm_score = comp_score = 0.0
    else:
        avg_score_10 = sum(e["score"] for e in evals) / len(evals)
        overall_score = round(avg_score_10 * 10, 1)
        tech_score = round(sum(e["technical_score"] for e in evals) / len(evals) * 10, 1)
        correctness_score = round(sum(e["correctness_score"] for e in evals) / len(evals) * 10, 1)
        comm_score = round(sum(e["clarity_score"] for e in evals) / len(evals) * 10, 1)
        comp_score = round(sum(e["completeness_score"] for e in evals) / len(evals) * 10, 1)

    if overall_score >= 85:
        category = "EXCELLENT"
    elif overall_score >= 70:
        category = "GOOD"
    elif overall_score >= 50:
        category = "AVERAGE"
    else:
        category = "NEEDS IMPROVEMENT"

    cursor.execute("UPDATE interviews SET overall_score = %s, status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = %s", (overall_score, interview_id))

    strengths_text = "Good core comprehension; clean answers; clear communication."
    weak_text = "Detailed code syntax; advanced edge case optimization."
    recs_text = f"Practice 10 {interview['role']} questions on Medium difficulty. Focus on technical definitions."

    # Save to interview_results
    cursor.execute("""
        INSERT INTO interview_results
        (interview_id, technical_score, correctness_score, communication_score, completeness_score, overall_score, performance_category, strengths, weak_areas, recommendations)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        interview_id, tech_score, correctness_score, comm_score, comp_score,
        overall_score, category, strengths_text, weak_text, recs_text
    ))

    conn.close()

    return {
        "interview_id": interview_id,
        "overall_score": overall_score,
        "performance_category": category,
        "technical_score": tech_score,
        "correctness_score": correctness_score,
        "communication_score": comm_score,
        "completeness_score": comp_score,
        "strengths": strengths_text,
        "weak_areas": weak_text,
        "recommendations": recs_text
    }

class TerminateInterviewReq(BaseModel):
    reason: str = "tab_switch"

@router.post("/{interview_id}/terminate")
def terminate_interview(interview_id: int, req: TerminateInterviewReq, current_user: dict = Depends(get_current_user_from_token)):
    user_id = int(current_user["sub"])
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM interviews WHERE id = %s AND user_id = %s", (interview_id, user_id))
    interview = cursor.fetchone()
    if not interview:
        conn.close()
        raise HTTPException(status_code=404, detail="Interview not found.")

    # Idempotent check
    if interview.get("status") in ["terminated", "completed"]:
        reason = interview.get("termination_reason") or ("tab_switch" if interview.get("status") == "terminated" else None)
        conn.close()
        return {
            "interview_id": interview_id,
            "status": interview["status"],
            "termination_reason": reason,
            "message": f"Interview is already {interview['status']}."
        }

    reason = req.reason or "tab_switch"

    try:
        cursor.execute(
            "UPDATE interviews SET status = 'terminated', termination_reason = %s, completed_at = CURRENT_TIMESTAMP WHERE id = %s",
            (reason, interview_id)
        )
    except Exception:
        cursor.execute(
            "UPDATE interviews SET status = 'terminated', completed_at = CURRENT_TIMESTAMP WHERE id = %s",
            (interview_id,)
        )

    # Save to interview_results
    cursor.execute("SELECT id FROM interview_results WHERE interview_id = %s", (interview_id,))
    if not cursor.fetchone():
        r_lower = (reason or "").lower()
        if "mobile" in r_lower or "phone" in r_lower:
            cat = "TERMINATED — MOBILE DETECTED"
            strengths_msg = "None - Interview terminated early due to AI proctoring violation."
            weak_msg = "Mobile phone or smart device detected in camera frame."
            rec_msg = "Ensure all mobile phones and electronic devices are placed out of view during proctored sessions."
        elif "paper" in r_lower or "book" in r_lower or "note" in r_lower:
            cat = "TERMINATED — PAPER/NOTES DETECTED"
            strengths_msg = "None - Interview terminated early due to AI proctoring violation."
            weak_msg = "Paper, notebook, or written reference materials detected in camera frame."
            rec_msg = "External notes and written reference materials are strictly prohibited during testing."
        elif "device" in r_lower or "laptop" in r_lower or "tv" in r_lower or "screen" in r_lower or "remote" in r_lower:
            cat = "TERMINATED — UNAUTHORIZED DEVICE"
            strengths_msg = "None - Interview terminated early due to AI proctoring violation."
            weak_msg = "Secondary electronic device or external display detected in camera frame."
            rec_msg = "Only the primary testing device is allowed in view of the proctor camera."
        elif "camera" in r_lower or "disconnect" in r_lower:
            cat = "TERMINATED — CAMERA DISABLED"
            strengths_msg = "None - Interview terminated early due to camera feed interruption."
            weak_msg = "Webcam stream was stopped or disconnected during active interview."
            rec_msg = "Maintain continuous webcam video feed throughout the entire interview."
        elif "multiple" in r_lower or "person" in r_lower:
            cat = "TERMINATED — MULTIPLE PERSONS"
            strengths_msg = "None - Interview terminated early due to unauthorized presence."
            weak_msg = "Multiple persons detected in camera frame during testing."
            rec_msg = "Candidate must be alone in a quiet room during the entire interview duration."
        else:
            cat = "TERMINATED — TAB SWITCH DETECTED"
            strengths_msg = "None - Interview terminated early due to tab switching."
            weak_msg = "Tab switching detected during active interview."
            rec_msg = "Stay on the interview tab throughout the interview duration."

        cursor.execute("""
            INSERT INTO interview_results
            (interview_id, technical_score, correctness_score, communication_score, completeness_score, overall_score, performance_category, strengths, weak_areas, recommendations)
            VALUES (%s, 0.0, 0.0, 0.0, 0.0, 0.0, %s, %s, %s, %s)
        """, (interview_id, cat, strengths_msg, weak_msg, rec_msg))

    conn.close()
    return {
        "interview_id": interview_id,
        "status": "terminated",
        "termination_reason": reason,
        "message": "Interview terminated successfully."
    }

@router.get("/{interview_id}/results")
def get_interview_results(interview_id: int, current_user: dict = Depends(get_current_user_from_token)):
    user_id = int(current_user["sub"])
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM interviews WHERE id = %s AND user_id = %s", (interview_id, user_id))
    interview = cursor.fetchone()
    if not interview:
        conn.close()
        raise HTTPException(status_code=404, detail="Interview not found.")

    cursor.execute("SELECT * FROM interview_results WHERE interview_id = %s ORDER BY id DESC LIMIT 1", (interview_id,))
    result = cursor.fetchone()

    cursor.execute("""
        SELECT q.question_order, q.question_text, a.user_answer, e.score, e.feedback, e.ideal_answer, e.improvement_suggestion
        FROM questions q
        LEFT JOIN answers a ON q.id = a.question_id
        LEFT JOIN evaluations e ON a.id = e.answer_id
        WHERE q.interview_id = %s
        ORDER BY q.question_order ASC
    """, (interview_id,))
    reviews = cursor.fetchall()

    conn.close()
    return {"interview": interview, "result": result, "reviews": reviews}

