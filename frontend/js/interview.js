let activeSession = null;
let currentIndex = 0;
let userAnswers = {};
let remainingSeconds = 0;
let timerInterval = null;
let speechRecognizer = null;
let isListening = false;
let isSubmitting = false;
let interviewTerminated = false;
let isInterviewCompleted = false;

// AI Camera Proctoring State
let proctorStream = null;
let cocoModel = null;
let detectionInterval = null;
let forbiddenDetectionsCount = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const dataStr = sessionStorage.getItem("active_interview");
  if (!dataStr) {
    window.location.href = "interview-setup.html";
    return;
  }

  try {
    activeSession = JSON.parse(dataStr);
  } catch (err) {
    console.error("Failed to parse active_interview:", err);
    window.location.href = "interview-setup.html";
    return;
  }

  if (!activeSession || !activeSession.interview_id) {
    window.location.href = "interview-setup.html";
    return;
  }

  let initialized = false;

  // 1. If questions already exist in session, render immediately without waiting
  if (activeSession.questions && activeSession.questions.length > 0) {
    initSpeech();
    initCountdownTimer();
    renderQuestion();
    initTabSwitchDetection();
    initProctorCamera();
    initialized = true;
  }

  // 2. Sync with remote session (handles page refresh, restores questions, checks status)
  try {
    const remoteSession = await ApiService.getInterview(activeSession.interview_id);
    if (remoteSession) {
      if (remoteSession.status === "terminated") {
        interviewTerminated = true;
        const reason = remoteSession.termination_reason || "tab_switch";
        showTerminationModal(reason, getTerminationDescription(reason));
        return;
      }
      if (remoteSession.status === "completed") {
        window.location.href = `results.html?id=${activeSession.interview_id}`;
        return;
      }

      // If session storage had no questions, restore them from DB!
      if (!initialized && remoteSession.questions && remoteSession.questions.length > 0) {
        activeSession.questions = remoteSession.questions;
        sessionStorage.setItem("active_interview", JSON.stringify(activeSession));
        initSpeech();
        initCountdownTimer();
        renderQuestion();
        initTabSwitchDetection();
        initProctorCamera();
        initialized = true;
      }
    }
  } catch (e) {
    console.warn("Could not fetch remote session status:", e);
  }

  // 3. Fallback: If still no questions after remote check, allow user to start fresh
  if (!activeSession.questions || activeSession.questions.length === 0) {
    const qText = document.getElementById("q-text");
    if (qText) {
      qText.innerHTML = `
        <div style="font-size:1.05rem; font-weight:600; color:var(--warning); margin-bottom:0.75rem;">
          ⚠️ No active questions found for this session.
        </div>
        <div style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:1.25rem;">
          Please launch an interview from the Practice setup page.
        </div>
        <a href="interview-setup.html" class="btn btn-primary" style="display:inline-block; padding:0.5rem 1.25rem;">
          Configure New Interview →
        </a>
      `;
    }
  }
});

/* --- Live AI Camera Proctoring System --- */
async function initProctorCamera() {
  const videoEl = document.getElementById("proctor-video");
  const statusBadge = document.getElementById("proctor-status-badge");
  const aiStatus = document.getElementById("proctor-ai-status");
  const scanLabel = document.getElementById("proctor-detection-label");

  try {
    const constraints = {
      video: {
        facingMode: "user", // Laptop webcam or mobile selfie camera
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };

    proctorStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (videoEl) {
      videoEl.width = 320;
      videoEl.height = 240;
      videoEl.srcObject = proctorStream;
      await videoEl.play().catch(e => console.warn("Proctor video play:", e));
    }

    if (statusBadge) {
      statusBadge.textContent = "CAMERA SECURED";
      statusBadge.className = "badge badge-green font-mono";
    }

    // Monitor if camera stream is closed/unplugged/interrupted
    const videoTrack = proctorStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        handleProctoringViolation("camera_disconnected", "Camera feed was stopped or disconnected.");
      };
    }

    // Load browser-side COCO-SSD machine learning model
    initObjectDetection();
  } catch (err) {
    console.error("Proctor camera initialization failed:", err);
    if (statusBadge) {
      statusBadge.textContent = "CAMERA ERROR";
      statusBadge.className = "badge badge-danger font-mono";
    }
    handleProctoringViolation("camera_disconnected", "Webcam access is required for proctoring but could not be initialized.");
  }
}

async function initObjectDetection() {
  const scanLabel = document.getElementById("proctor-detection-label");
  const aiStatus = document.getElementById("proctor-ai-status");

  try {
    if (window.cocoSsd) {
      if (scanLabel) scanLabel.textContent = "ARMING AI...";
      cocoModel = await window.cocoSsd.load();
      if (aiStatus) {
        aiStatus.textContent = "AI ARMED";
        aiStatus.className = "badge badge-green font-mono";
      }
      if (scanLabel) scanLabel.textContent = "MONITORING";
      startDetectionLoop();
    } else {
      if (scanLabel) scanLabel.textContent = "MONITORING";
    }
  } catch (e) {
    console.warn("Could not load COCO-SSD object detection model:", e);
    if (scanLabel) scanLabel.textContent = "MONITORING";
  }
}

function startDetectionLoop() {
  if (detectionInterval) clearInterval(detectionInterval);

  // Prohibited object classes in COCO-SSD dataset:
  // cell phone, book (paper/notebook/notes), laptop (secondary screen), tv (monitor), remote (electronic gadget)
  const FORBIDDEN_CLASSES = ["cell phone", "book", "laptop", "tv", "remote"];

  detectionInterval = setInterval(async () => {
    if (interviewTerminated || isInterviewCompleted || !cocoModel) return;

    const videoEl = document.getElementById("proctor-video");
    const scanLabel = document.getElementById("proctor-detection-label");
    const warnBanner = document.getElementById("proctor-warning-banner");
    const warnText = document.getElementById("proctor-warning-text");

    if (!videoEl || videoEl.readyState < 2) return;

    try {
      const predictions = await cocoModel.detect(videoEl);
      if (interviewTerminated || isInterviewCompleted) return;

      let detectedForbidden = null;
      let personsCount = 0;

      for (const p of predictions) {
        const cls = p.class.toLowerCase();
        if (cls === "person" && p.score >= 0.45) {
          personsCount++;
        }
        if (FORBIDDEN_CLASSES.includes(cls) && p.score >= 0.45) {
          detectedForbidden = { class: cls, score: p.score };
          break;
        }
      }

      // Check 1: Forbidden object detected (cell phone, book/paper notes, secondary device)
      if (detectedForbidden) {
        forbiddenDetectionsCount++;
        if (scanLabel) scanLabel.textContent = `ALERT: ${detectedForbidden.class.toUpperCase()}`;
        if (warnBanner && warnText) {
          warnText.textContent = `🚨 Suspicious item detected: ${detectedForbidden.class.toUpperCase()}!`;
          warnBanner.style.display = "block";
        }

        // Trigger termination on high confidence or 2 consecutive scan intervals to avoid one-frame sensor noise
        if (forbiddenDetectionsCount >= 2 || detectedForbidden.score >= 0.65) {
          let reasonCode = "unauthorized_device_detected";
          let label = "Unauthorized device";

          if (detectedForbidden.class === "cell phone") {
            reasonCode = "mobile_phone_detected";
            label = "Mobile phone or smart device";
          } else if (detectedForbidden.class === "book") {
            reasonCode = "paper_detected";
            label = "Paper, notebook, or written notes";
          } else if (detectedForbidden.class === "laptop" || detectedForbidden.class === "tv") {
            reasonCode = "unauthorized_device_detected";
            label = "Secondary electronic display / device";
          }

          handleProctoringViolation(reasonCode, `${label} detected in camera frame.`);
        }
        return;
      }

      // Check 2: Multiple persons detected in frame
      if (personsCount > 1) {
        forbiddenDetectionsCount++;
        if (warnBanner && warnText) {
          warnText.textContent = `🚨 Multiple people detected in frame!`;
          warnBanner.style.display = "block";
        }
        if (forbiddenDetectionsCount >= 2) {
          handleProctoringViolation("multiple_persons_detected", "Multiple persons detected in your camera frame.");
        }
        return;
      }

      // Frame is clear
      forbiddenDetectionsCount = 0;
      if (warnBanner) warnBanner.style.display = "none";
      if (scanLabel) scanLabel.textContent = "MONITORING — CLEAR";

    } catch (detErr) {
      console.warn("Detection cycle error:", detErr);
    }
  }, 800);
}

function handleProctoringViolation(reason, details) {
  if (interviewTerminated || isSubmitting || isInterviewCompleted) return;
  interviewTerminated = true;

  // 1. Immediately stop countdown timer
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // 2. Stop object detection loop
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }

  // 3. Stop proctor video stream
  if (proctorStream) {
    proctorStream.getTracks().forEach(t => t.stop());
  }

  // 4. Disable UI controls
  const inputEl = document.getElementById("answer-input");
  if (inputEl) inputEl.disabled = true;
  const btnSubmit = document.getElementById("btn-submit");
  if (btnSubmit) btnSubmit.disabled = true;
  const btnPrev = document.getElementById("btn-prev");
  if (btnPrev) btnPrev.disabled = true;

  // 5. Notify backend of termination
  if (activeSession && activeSession.interview_id) {
    notifyBackendTermination(activeSession.interview_id, reason);
  }

  // 6. Show termination modal
  showTerminationModal(reason, details);
}

function initCountdownTimer() {
  const interviewId = activeSession.interview_id;
  const durationSec = activeSession.duration_seconds || activeSession.total_duration_seconds || (activeSession.questions ? activeSession.questions.length * 180 : 1800);

  const startKey = `interview_start_timestamp_${interviewId}`;
  let startTime = sessionStorage.getItem(startKey);

  if (!startTime || isNaN(parseInt(startTime, 10))) {
    if (activeSession.start_timestamp && !isNaN(parseInt(activeSession.start_timestamp, 10))) {
      startTime = parseInt(activeSession.start_timestamp, 10);
    } else {
      startTime = Date.now();
    }
    sessionStorage.setItem(startKey, startTime);
  } else {
    startTime = parseInt(startTime, 10);
  }

  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
  remainingSeconds = Math.max(0, durationSec - elapsedSeconds);

  updateTimerDisplay();

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remainingSeconds--;
    if (remainingSeconds <= 0) {
      remainingSeconds = 0;
      updateTimerDisplay();
      clearInterval(timerInterval);
      handleTimeUp();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function updateTimerDisplay() {
  if (isNaN(remainingSeconds) || remainingSeconds < 0) {
    remainingSeconds = 0;
  }

  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  const displayStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  
  const clockEl = document.getElementById("countdown-clock");
  if (clockEl) {
    clockEl.textContent = displayStr;
    clockEl.classList.remove("clock-warning", "clock-danger");
    if (remainingSeconds <= 60) {
      clockEl.classList.add("clock-danger");
    } else if (remainingSeconds <= 300) {
      clockEl.classList.add("clock-warning");
    }
  }
}

async function handleTimeUp() {
  if (isSubmitting) return;
  isSubmitting = true;

  const banner = document.getElementById("timeout-banner");
  if (banner) banner.style.display = "block";

  // Save current response
  const q = activeSession.questions[currentIndex];
  if (q) {
    const inputEl = document.getElementById("answer-input");
    if (inputEl) userAnswers[q.id] = inputEl.value.trim();
  }

  // Submit current answer if present
  try {
    if (q && userAnswers[q.id]) {
      await ApiService.submitAnswer(activeSession.interview_id, q.id, userAnswers[q.id]);
    }
  } catch (e) {
    console.error("Auto submit answer error:", e);
  }

  setTimeout(async () => {
    await finalizeInterview();
  }, 1200);
}

function renderQuestion() {
  if (!activeSession || !activeSession.questions || activeSession.questions.length === 0) {
    return;
  }

  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= activeSession.questions.length) currentIndex = activeSession.questions.length - 1;

  const q = activeSession.questions[currentIndex];
  if (!q) return;

  const total = activeSession.questions.length;
  const num = currentIndex + 1;

  const qNumTag = document.getElementById("q-number-tag");
  if (qNumTag) qNumTag.textContent = `Question ${num} of ${total}`;

  const qTypeTag = document.getElementById("q-type-tag");
  if (qTypeTag) qTypeTag.textContent = (q.question_type || activeSession.interview_type || "Technical").toUpperCase();

  const qText = document.getElementById("q-text");
  if (qText) qText.textContent = q.question_text || "No question content.";

  const inputEl = document.getElementById("answer-input");
  if (inputEl) inputEl.value = userAnswers[q.id] || "";

  const prevBtn = document.getElementById("btn-prev");
  if (prevBtn) prevBtn.disabled = (currentIndex === 0);

  const nextBtn = document.getElementById("btn-submit");
  if (nextBtn) {
    if (num === total) {
      nextBtn.textContent = "Finish & Evaluate Interview 🏆";
    } else {
      nextBtn.textContent = "Submit Answer ➔";
    }
  }
}

function navigateQuestion(dir) {
  const q = activeSession.questions[currentIndex];
  userAnswers[q.id] = document.getElementById("answer-input").value;
  const newIdx = currentIndex + dir;
  if (newIdx >= 0 && newIdx < activeSession.questions.length) {
    currentIndex = newIdx;
    renderQuestion();
  }
}

function skipQuestion() {
  const q = activeSession.questions[currentIndex];
  userAnswers[q.id] = "";
  if (currentIndex < activeSession.questions.length - 1) {
    currentIndex++;
    renderQuestion();
  } else {
    submitAnswer();
  }
}

async function submitAnswer() {
  if (isSubmitting) return;

  const q = activeSession.questions[currentIndex];
  const text = document.getElementById("answer-input").value.trim();
  userAnswers[q.id] = text;

  const btn = document.getElementById("btn-submit");
  btn.disabled = true;
  btn.textContent = "⏳ Evaluating Answer...";

  try {
    await ApiService.submitAnswer(activeSession.interview_id, q.id, text);

    if (currentIndex < activeSession.questions.length - 1) {
      currentIndex++;
      renderQuestion();
    } else {
      isSubmitting = true;
      await finalizeInterview();
    }
  } catch (err) {
    console.error("Submit answer error:", err);
    alert(err.message || "Unable to submit answer. Please try again.");
  } finally {
    if (!isSubmitting) {
      btn.disabled = false;
    }
  }
}

async function finalizeInterview() {
  isInterviewCompleted = true;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
  if (proctorStream) {
    proctorStream.getTracks().forEach(t => t.stop());
  }

  try {
    await ApiService.completeInterview(activeSession.interview_id);
    window.location.href = `results.html?id=${activeSession.interview_id}`;
  } catch (err) {
    console.error("Finalization error:", err);
    window.location.href = `results.html?id=${activeSession.interview_id}`;
  }
}

/* --- Strict Tab Switch Detection System --- */
function initTabSwitchDetection() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      handleTabSwitchViolation();
    } else if (document.visibilityState === "visible") {
      if (interviewTerminated) {
        showTerminationModal("tab_switch");
      }
    }
  });

  window.addEventListener("blur", () => {
    handleTabSwitchViolation();
  });

  window.addEventListener("focus", () => {
    if (interviewTerminated) {
      showTerminationModal("tab_switch");
    }
  });
}

function handleTabSwitchViolation() {
  if (interviewTerminated || isSubmitting || isInterviewCompleted) return;
  interviewTerminated = true;

  // 1. Immediately stop countdown timer
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // 2. Stop camera and object detection
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
  if (proctorStream) {
    proctorStream.getTracks().forEach(t => t.stop());
  }

  // 3. Disable UI controls
  const inputEl = document.getElementById("answer-input");
  if (inputEl) inputEl.disabled = true;
  const btnSubmit = document.getElementById("btn-submit");
  if (btnSubmit) btnSubmit.disabled = true;
  const btnPrev = document.getElementById("btn-prev");
  if (btnPrev) btnPrev.disabled = true;

  // 4. Notify backend of termination
  if (activeSession && activeSession.interview_id) {
    notifyBackendTermination(activeSession.interview_id, "tab_switch");
  }

  // 5. If currently visible/focused, display termination modal
  if (document.visibilityState === "visible" || document.hasFocus()) {
    showTerminationModal("tab_switch");
  }
}

function notifyBackendTermination(interviewId, reason = "tab_switch") {
  const url = `${API_BASE_URL}/api/interviews/${interviewId}/terminate`;
  const token = ApiService.getAuthToken();

  if (navigator.sendBeacon && token) {
    const payload = JSON.stringify({ reason: reason });
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: payload,
      keepalive: true
    }).catch(err => console.error("Termination fetch error:", err));
  } else {
    ApiService.terminateInterview(interviewId, reason)
      .catch(err => console.error("Terminate interview API error:", err));
  }
}

function getTerminationDescription(reason) {
  const rLower = (reason || "").toLowerCase();
  if (rLower.includes("mobile") || rLower.includes("phone")) {
    return "Mobile phone detected in front of the camera frame.";
  } else if (rLower.includes("paper") || rLower.includes("book") || rLower.includes("note")) {
    return "Paper, notebook, or written notes detected in front of the camera frame.";
  } else if (rLower.includes("device") || rLower.includes("laptop") || rLower.includes("tv")) {
    return "Secondary electronic screen or device detected in camera frame.";
  } else if (rLower.includes("camera") || rLower.includes("disconnect")) {
    return "Webcam feed was disconnected or turned off during testing.";
  } else if (rLower.includes("multiple") || rLower.includes("person")) {
    return "Multiple people detected in your camera frame.";
  }
  return "Tab switching or leaving the interview window was detected.";
}

function showTerminationModal(reason = "tab_switch", details = "") {
  const modal = document.getElementById("termination-modal");
  const iconEl = document.getElementById("termination-icon");
  const titleEl = document.getElementById("termination-title");
  const msgEl = document.getElementById("termination-message");

  const rLower = (reason || "").toLowerCase();

  if (iconEl && titleEl && msgEl) {
    if (rLower.includes("mobile") || rLower.includes("phone")) {
      iconEl.textContent = "📱";
      titleEl.textContent = "Interview Ended — Mobile Detected";
      msgEl.innerHTML = `<strong>Mobile phone detected in camera frame.</strong><br><br>The use of mobile phones or smart devices is strictly prohibited. Your interview has been ended to preserve test integrity.`;
    } else if (rLower.includes("paper") || rLower.includes("book") || rLower.includes("note")) {
      iconEl.textContent = "📄";
      titleEl.textContent = "Interview Ended — Notes Detected";
      msgEl.innerHTML = `<strong>Paper or written notes detected in frame.</strong><br><br>Holding or referencing written material or books is strictly prohibited. Your interview has been ended.`;
    } else if (rLower.includes("device") || rLower.includes("laptop") || rLower.includes("tv") || rLower.includes("remote")) {
      iconEl.textContent = "💻";
      titleEl.textContent = "Interview Ended — Device Detected";
      msgEl.innerHTML = `<strong>Secondary electronic device detected in frame.</strong><br><br>Only your primary testing computer is allowed. Your interview has been ended.`;
    } else if (rLower.includes("camera") || rLower.includes("disconnect")) {
      iconEl.textContent = "📹";
      titleEl.textContent = "Interview Ended — Camera Disconnected";
      msgEl.innerHTML = `<strong>Live camera feed was disconnected or turned off.</strong><br><br>Continuous camera proctoring is mandatory throughout the entire interview.`;
    } else if (rLower.includes("multiple") || rLower.includes("person")) {
      iconEl.textContent = "👥";
      titleEl.textContent = "Interview Ended — Multiple Persons";
      msgEl.innerHTML = `<strong>Multiple people were detected in the camera frame.</strong><br><br>You must be alone in the room during the interview.`;
    } else {
      iconEl.textContent = "⚠️";
      titleEl.textContent = "Interview Ended — Tab Switch";
      msgEl.innerHTML = `<strong>Tab switching was detected.</strong><br><br>You left or blurred the interview window. According to the interview rules, your interview has been automatically ended.`;
    }
  }

  if (modal) {
    modal.style.display = "flex";
  }
}

function viewTerminationResults() {
  if (activeSession && activeSession.interview_id) {
    window.location.href = `results.html?id=${activeSession.interview_id}`;
  } else {
    window.location.href = "dashboard.html";
  }
}

function initSpeech() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return;
  speechRecognizer = new Speech();
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = 'en-US';

  speechRecognizer.onresult = (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    const input = document.getElementById("answer-input");
    input.value += (input.value ? ' ' : '') + text;
  };
}

function toggleVoiceInput() {
  if (!speechRecognizer) {
    alert("Browser speech recognition not supported.");
    return;
  }

  const btn = document.getElementById("mic-btn");
  if (!isListening) {
    speechRecognizer.start();
    isListening = true;
    btn.textContent = "⏹️ Stop Voice";
    btn.style.color = "var(--danger)";
  } else {
    speechRecognizer.stop();
    isListening = false;
    btn.textContent = "🎙️ Voice Input";
    btn.style.color = "";
  }
}
