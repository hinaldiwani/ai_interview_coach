import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional

from .config import get_ai_api_key

# Mapping required by specification:
# Easy -> 10 questions
# Medium -> 20 questions
# Hard -> 30 questions
DIFFICULTY_QUESTION_MAP = {
    "Easy": 10,
    "Medium": 20,
    "Hard": 30
}

MODELS_TO_TRY = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.5-flash"]


def get_question_count_by_difficulty(difficulty: str) -> int:
    """Returns the mandatory question count based on interview difficulty level."""
    diff_key = (difficulty or "Medium").strip().title()
    return DIFFICULTY_QUESTION_MAP.get(diff_key, 20)


def normalize_text(text: str) -> str:
    """Normalizes string for deduplication comparison."""
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9\s]", "", text)
    return " ".join(text.split())


def deduplicate_questions(questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Removes duplicate or near-duplicate questions based on normalized word overlap."""
    unique = []
    seen_texts = set()

    for q in questions:
        norm = normalize_text(q.get("question_text", ""))
        if not norm:
            continue
        words = set(norm.split())
        is_duplicate = False

        for existing_words in seen_texts:
            intersection = words.intersection(existing_words)
            union = words.union(existing_words)
            jaccard_sim = len(intersection) / max(len(union), 1)
            if jaccard_sim > 0.65:
                is_duplicate = True
                break

        if not is_duplicate:
            seen_texts.add(frozenset(words))
            unique.append(q)

    return unique


def get_type_prompt_instructions(type_name: str, role: str, experience: str, difficulty: str, focus_area: str = "") -> str:
    """Generates prompt guidelines tailored to interview type and focus domain."""
    t = (type_name or "Technical").strip().lower()
    focus_clause = f"\nSpecific Focus for this batch: {focus_area}." if focus_area else ""

    if t == "technical":
        return f"""
        Generate STRICTLY TECHNICAL interview questions tailored to '{role}'.
        - Target Experience Level: {experience}
        - Target Difficulty Level: {difficulty}
        - Focus Areas: Language internals, core concepts, data structures, algorithms, frameworks, APIs, database optimization, architecture, debugging.{focus_clause}
        - ABSOLUTELY DO NOT include HR, behavioral, personal background, or generic questions.
        """
    elif t == "hr":
        return f"""
        Generate STRICTLY HR, recruitment, and cultural-fit interview questions.
        - Target Role (Context): {role}
        - Target Experience Level: {experience}
        - Target Difficulty Level: {difficulty}
        - Focus Areas: Professional motivation, career trajectory, team dynamics, communication, constructive feedback, company values.{focus_clause}
        - ABSOLUTELY DO NOT ask coding syntax or technical definition questions.
        """
    elif t == "behavioral":
        return f"""
        Generate STRICTLY BEHAVIORAL and situational interview questions.
        - Target Role (Context): {role}
        - Target Experience Level: {experience}
        - Target Difficulty Level: {difficulty}
        - Formatting Requirement: Must use situational framing such as 'Tell me about a time when...', 'Describe a scenario where...'.
        - Focus Areas: STAR method scenarios: handling tight deadlines, cross-team conflict, architectural disagreements, failure ownership, leadership.{focus_clause}
        - ABSOLUTELY DO NOT ask direct coding syntax or technology trivia questions.
        """
    else:
        return f"Generate high-quality interview questions for role '{role}', experience '{experience}', difficulty '{difficulty}'.{focus_clause}"


def _call_gemini_batch(
    client: Any,
    role: str,
    experience: str,
    batch_type: str,
    difficulty: str,
    batch_count: int,
    focus_area: str = ""
) -> List[Dict[str, Any]]:
    """Helper to query Gemini API for a single batch of questions with their ideal answers."""
    from google.genai import types

    type_instructions = get_type_prompt_instructions(batch_type, role, experience, difficulty, focus_area)

    prompt = f"""
    You are an expert interview coach and technical hiring manager.
    Generate exactly {batch_count} realistic interview questions for:
    - Role: {role}
    - Experience: {experience}
    - Interview Type: {batch_type}
    - Difficulty: {difficulty}

    {type_instructions}

    REQUIREMENTS:
    1. Every question MUST be paired with its benchmark "ideal_answer" and "key_concepts".
    2. "ideal_answer": Keep it concise (strictly 1 to 2 clear sentences capturing the core solution, principle, or best practice).
    3. "key_concepts": Comma-separated list of 3-4 critical keywords.
    4. "topic": Brief category (e.g., 'Concurrency', 'System Design', 'Conflict Resolution').

    Format output as a valid JSON array of objects with the exact schema:
    [
      {{
        "question_text": "...",
        "topic": "...",
        "ideal_answer": "...",
        "key_concepts": "..."
      }}
    ]
    Do not wrap in markdown or backticks. Return valid JSON only.
    """

    last_error = None
    for model_name in MODELS_TO_TRY:
        try:
            config = types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.6,
                max_output_tokens=1500
            )
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config
            )
            raw_text = (response.text or "").strip()
            if not raw_text:
                continue

            # Strip markdown if present
            if raw_text.startswith("```"):
                raw_text = re.sub(r"^```(?:json)?\n?", "", raw_text)
                raw_text = re.sub(r"\n?```$", "", raw_text)

            parsed = json.loads(raw_text)
            if isinstance(parsed, dict) and "questions" in parsed:
                parsed = parsed["questions"]

            if isinstance(parsed, list) and len(parsed) > 0:
                validated = []
                for item in parsed:
                    if isinstance(item, dict) and item.get("question_text"):
                        validated.append({
                            "question_text": str(item.get("question_text", "")).strip(),
                            "topic": str(item.get("topic", "General")).strip(),
                            "ideal_answer": str(item.get("ideal_answer", "")).strip() or "Comprehensive answer covering core principles.",
                            "key_concepts": str(item.get("key_concepts", "")).strip() or "Core concepts, Implementation details",
                            "question_type": batch_type,
                            "difficulty": difficulty
                        })
                if validated:
                    return validated[:batch_count]
        except Exception as err:
            last_error = err
            print(f"[Gemini Generator] Model '{model_name}' batch attempt encountered error: {err}")
            continue

    if last_error:
        print(f"[Gemini Generator Warning] All models failed for batch ({batch_type}, {focus_area}): {last_error}")
    return []


def generate_questions(
    role: str,
    experience: str,
    interview_type: str,
    difficulty: str,
    total_questions: Optional[int] = None
) -> List[Dict[str, Any]]:
    """
    Generates interview questions and benchmark answers strictly using the Gemini API.
    Enforces specification:
      - Easy   -> 10 questions
      - Medium -> 20 questions
      - Hard   -> 30 questions
    """
    api_key = get_ai_api_key()
    if not api_key:
        raise ValueError(
            "Gemini API key is not configured. Please add GEMINI_API_KEY to your .env file to generate interview questions via AI."
        )

    norm_difficulty = (difficulty or "Medium").strip().title()
    if norm_difficulty not in DIFFICULTY_QUESTION_MAP:
        norm_difficulty = "Medium"

    # Enforce mandatory question counts per difficulty
    target_count = DIFFICULTY_QUESTION_MAP[norm_difficulty]
    target_type = (interview_type or "Technical").strip().title()

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
    except Exception as e:
        raise RuntimeError(f"Failed to initialize Gemini GenAI Client: {e}")

    # Build plan for parallel batches of ~10 questions each
    # This prevents prompt token truncation, network timeouts, and ensures varied subtopics
    batch_plans = []

    if target_type.lower() == "mixed":
        if target_count == 10:  # Easy
            batch_plans.append(("Technical", 4, "Fundamental programming, syntax, basic problem solving"))
            batch_plans.append(("Behavioral", 3, "Team collaboration, learning, deadline management"))
            batch_plans.append(("HR", 3, "Motivation, career ambitions, company fit"))
        elif target_count == 20:  # Medium
            batch_plans.append(("Technical", 8, "Core algorithms, data structures, framework patterns, database queries"))
            batch_plans.append(("Behavioral", 6, "STAR scenarios: conflict resolution, pressure, accountability"))
            batch_plans.append(("HR", 6, "Professional growth, feedback reception, workplace culture"))
        else:  # Hard (30)
            batch_plans.append(("Technical", 12, "Advanced architecture, performance optimization, concurrency, system design"))
            batch_plans.append(("Behavioral", 9, "High-stakes leadership, critical technical trade-offs, crisis management"))
            batch_plans.append(("HR", 9, "Executive presence, strategic career direction, cross-functional leadership"))
    else:
        # Single type interview: divide into batches with diverse engineering focuses
        if target_count == 10:  # Easy
            batch_plans.append((target_type, 10, "Foundational principles, core syntax, common definitions, basic scenarios"))
        elif target_count == 20:  # Medium
            batch_plans.append((target_type, 10, "Core concepts, frameworks, standard design patterns, API workflows"))
            batch_plans.append((target_type, 10, "Practical engineering scenarios, error handling, performance tuning, debugging"))
        else:  # Hard (30)
            batch_plans.append((target_type, 10, "Language internals, deep memory management, complex algorithms & data structures"))
            batch_plans.append((target_type, 10, "Distributed systems, architectural scalability, security, microservices trade-offs"))
            batch_plans.append((target_type, 10, "Real-world production debugging, incident recovery, resilience, edge-case optimization"))

    print(f"\n[Gemini Generator] Generating {target_count} questions for '{role}' ({norm_difficulty}, {target_type}) across {len(batch_plans)} batches...")

    all_generated: List[Dict[str, Any]] = []

    # Run batches concurrently for lightning-fast latency
    with ThreadPoolExecutor(max_workers=len(batch_plans)) as executor:
        futures = {
            executor.submit(
                _call_gemini_batch,
                client,
                role,
                experience,
                b_type,
                norm_difficulty,
                b_count,
                b_focus
            ): (b_type, b_count)
            for b_type, b_count, b_focus in batch_plans
        }

        for future in as_completed(futures):
            try:
                batch_res = future.result()
                if batch_res:
                    all_generated.extend(batch_res)
            except Exception as exc:
                print(f"[Gemini Generator] Batch execution failed: {exc}")

    # Deduplicate generated questions
    final_questions = deduplicate_questions(all_generated)

    # Top-up if deduplication or a batch returned slightly fewer questions
    if len(final_questions) < target_count:
        missing = target_count - len(final_questions)
        print(f"[Gemini Generator] Batch count ({len(final_questions)}) below target ({target_count}). Requesting top-up of {missing} questions...")
        top_up_type = target_type if target_type.lower() != "mixed" else "Technical"
        top_up = _call_gemini_batch(
            client,
            role,
            experience,
            top_up_type,
            norm_difficulty,
            missing,
            "Additional unique scenario-based questions"
        )
        for item in top_up:
            if len(final_questions) >= target_count:
                break
            final_questions.append(item)

    if not final_questions:
        raise RuntimeError(
            f"Failed to generate questions from Gemini API. Please check your network connection and verify your GEMINI_API_KEY."
        )

    # Ensure exact required count and sequential order numbers
    selected = final_questions[:target_count]
    for idx, q in enumerate(selected):
        q["question_order"] = idx + 1
        q["difficulty"] = norm_difficulty
        if not q.get("question_type"):
            q["question_type"] = target_type

    print(f"[Gemini Generator] Successfully compiled {len(selected)} AI questions with benchmark ideal answers.\n")
    return selected
