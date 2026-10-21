document.addEventListener("DOMContentLoaded", () => {
  restoreSavedConfig();
});

function restoreSavedConfig() {
  const saved = sessionStorage.getItem("saved_interview_config");
  if (!saved) return;

  try {
    const config = JSON.parse(saved);
    if (config.role) {
      const roleEl = document.getElementById("role");
      if (roleEl) roleEl.value = config.role;
    }
    if (config.experience) {
      const expRadio = document.querySelector(`input[name='experience'][value='${config.experience}']`);
      if (expRadio) {
        expRadio.checked = true;
        const card = expRadio.closest(".option-card");
        if (card) selectOptionCard(card, "experience");
      }
    }
    if (config.interview_type || config.type) {
      const typeVal = config.interview_type || config.type;
      const typeRadio = document.querySelector(`input[name='type'][value='${typeVal}']`);
      if (typeRadio) {
        typeRadio.checked = true;
        const card = typeRadio.closest(".option-card");
        if (card) selectOptionCard(card, "type");
      }
    }
    if (config.difficulty) {
      const diffEl = document.getElementById("difficulty");
      if (diffEl) diffEl.value = config.difficulty;
    }
    if (config.total_questions) {
      const countEl = document.getElementById("questions_count");
      if (countEl) countEl.value = config.total_questions;
    }

    const setupNotice = document.getElementById("setup-notice");
    if (setupNotice) {
      setupNotice.textContent = "✓ Your selected interview configuration has been restored.";
      setupNotice.style.display = "block";
    }

    sessionStorage.removeItem("saved_interview_config");
  } catch (e) {
    console.error("Failed to restore saved interview config:", e);
  }
}

let setupCameraStream = null;
let isCameraVerified = false;

async function toggleSetupCamera() {
  const videoEl = document.getElementById("setup-camera-video");
  const placeholder = document.getElementById("setup-camera-placeholder");
  const badge = document.getElementById("setup-camera-badge");
  const faceGuide = document.getElementById("setup-face-guide");
  const btnText = document.getElementById("camera-btn-text");
  const cameraNotice = document.getElementById("camera-notice");

  if (cameraNotice) cameraNotice.style.display = "none";

  if (setupCameraStream) {
    // Turn off camera
    setupCameraStream.getTracks().forEach(t => t.stop());
    setupCameraStream = null;
    isCameraVerified = false;
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.style.display = "none";
    }
    if (placeholder) placeholder.style.display = "block";
    if (faceGuide) faceGuide.style.display = "none";
    if (badge) {
      badge.textContent = "CAMERA REQUIRED";
      badge.className = "badge badge-danger font-mono";
    }
    if (btnText) btnText.textContent = "Turn On Camera";
    return;
  }

  // Turn on camera (facingMode: 'user' for laptop webcam or mobile selfie camera)
  try {
    const constraints = {
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };
    setupCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (videoEl) {
      videoEl.srcObject = setupCameraStream;
      videoEl.style.display = "block";
      await videoEl.play().catch(e => console.warn("Video preview play error:", e));
    }
    if (placeholder) placeholder.style.display = "none";
    if (faceGuide) faceGuide.style.display = "block";
    if (badge) {
      badge.textContent = "✓ CAMERA VERIFIED";
      badge.className = "badge badge-green font-mono";
    }
    if (btnText) btnText.textContent = "Turn Off Camera";
    isCameraVerified = true;
  } catch (err) {
    console.error("Camera access error:", err);
    isCameraVerified = false;
    if (cameraNotice) {
      cameraNotice.textContent = "⚠️ Camera access failed. Please ensure camera permissions are granted in your browser.";
      cameraNotice.style.display = "block";
    }
  }
}

async function handleStartInterview(e) {
  e.preventDefault();

  // 1. Mandatory Camera Verification Check
  const cameraNotice = document.getElementById("camera-notice");
  if (!isCameraVerified || !setupCameraStream) {
    if (cameraNotice) {
      cameraNotice.textContent = "⚠️ Camera is required! Please click 'Turn On Camera' to verify your camera feed before starting.";
      cameraNotice.style.display = "block";
      cameraNotice.scrollIntoView({ behavior: 'smooth' });
    }
    return;
  } else if (cameraNotice) {
    cameraNotice.style.display = "none";
  }

  // 2. Rules Agreement Check
  const agreeCb = document.getElementById("agree-rules");
  const rulesNotice = document.getElementById("rules-notice");
  if (agreeCb && !agreeCb.checked) {
    if (rulesNotice) {
      rulesNotice.textContent = "Please accept the AI proctoring rules before starting.";
      rulesNotice.style.display = "block";
      rulesNotice.scrollIntoView({ behavior: 'smooth' });
    }
    return;
  } else if (rulesNotice) {
    rulesNotice.style.display = "none";
  }

  const role = document.getElementById("role").value;
  const expEl = document.querySelector("input[name='experience']:checked");
  const typeEl = document.querySelector("input[name='type']:checked");
  const experience = expEl ? expEl.value : "Fresher";
  const interview_type = typeEl ? typeEl.value : "Technical";
  const difficulty = document.getElementById("difficulty").value;
  const total_questions = parseInt(document.getElementById("questions_count").value, 10);

  // 3. Detect if user is NOT logged in BEFORE making API request
  const token = ApiService.getAuthToken();
  if (!token) {
    const config = { role, experience, interview_type, difficulty, total_questions };
    sessionStorage.setItem("saved_interview_config", JSON.stringify(config));
    sessionStorage.setItem("redirect_after_login", "interview-setup.html");
    sessionStorage.setItem("login_notice", "Please log in to run an interview.");

    const noticeDiv = document.getElementById("auth-notice");
    if (noticeDiv) {
      noticeDiv.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <span>🔒 Please log in to run an interview. Your configuration has been saved.</span>
          <a href="login.html" class="btn btn-primary" style="padding:0.35rem 0.85rem; font-size:0.8rem;">Log In Now →</a>
        </div>
      `;
      noticeDiv.style.display = "block";
      noticeDiv.scrollIntoView({ behavior: 'smooth' });
    }

    setTimeout(() => {
      window.location.href = "login.html";
    }, 1200);
    return;
  }

  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "⏳ Generating AI questions via Gemini API...";

  try {
    const res = await ApiService.createInterview(role, experience, interview_type, difficulty, total_questions);
    
    // Release preview stream so camera is ready for live interview
    if (setupCameraStream) {
      setupCameraStream.getTracks().forEach(t => t.stop());
      setupCameraStream = null;
    }

    sessionStorage.removeItem("saved_interview_config");
    sessionStorage.setItem("active_interview", JSON.stringify(res));
    window.location.href = "interview.html";
  } catch (err) {
    const noticeDiv = document.getElementById("auth-notice");
    if (noticeDiv) {
      noticeDiv.innerHTML = `⚠️ <strong>Generation Error:</strong> ${err.message || "Execution failed. Please verify your Gemini API key in .env and try again."}`;
      noticeDiv.style.display = "block";
      noticeDiv.scrollIntoView({ behavior: 'smooth' });
    } else {
      alert(err.message || "Execution failed. Please try again.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Run Interview";
  }
}

function selectOptionCard(cardEl, groupName) {
  const parent = cardEl.parentElement;
  parent.querySelectorAll(".option-card").forEach(c => c.classList.remove("selected"));
  cardEl.classList.add("selected");
  const radio = cardEl.querySelector("input[type='radio']");
  if (radio) radio.checked = true;
  updateEstimatedDuration();
}

const DURATION_MATRIX = {
  "Technical": { "Easy": 120, "Medium": 180, "Hard": 240 },
  "HR": { "Easy": 90, "Medium": 120, "Hard": 180 },
  "Behavioral": { "Easy": 180, "Medium": 240, "Hard": 300 },
  "Mixed": { "Easy": 150, "Medium": 180, "Hard": 240 }
};

function updateEstimatedDuration() {
  const typeEl = document.querySelector("input[name='type']:checked");
  const typeVal = typeEl ? typeEl.value : "Technical";
  const diffEl = document.getElementById("difficulty");
  const diffVal = diffEl ? diffEl.value : "Medium";
  const countEl = document.getElementById("questions_count");
  const countVal = countEl ? parseInt(countEl.value, 10) : 10;

  const t = DURATION_MATRIX[typeVal] || DURATION_MATRIX["Technical"];
  const secPerQ = t[diffVal] || 180;
  const totalSec = countVal * secPerQ;

  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;

  let label = "";
  if (secs > 0) {
    label = `${mins} minutes ${secs} seconds`;
  } else {
    label = `${mins} minutes`;
  }

  const tag = document.getElementById("est-duration-tag");
  if (tag) tag.textContent = label;
}

const DIFFICULTY_COUNT_MAP = {
  "Easy": "10",
  "Medium": "20",
  "Hard": "30"
};

const COUNT_DIFFICULTY_MAP = {
  "10": "Easy",
  "20": "Medium",
  "30": "Hard"
};

function handleDifficultyChange() {
  const diffEl = document.getElementById("difficulty");
  const countEl = document.getElementById("questions_count");
  if (diffEl && countEl && DIFFICULTY_COUNT_MAP[diffEl.value]) {
    countEl.value = DIFFICULTY_COUNT_MAP[diffEl.value];
  }
  updateEstimatedDuration();
}

function handleCountChange() {
  const diffEl = document.getElementById("difficulty");
  const countEl = document.getElementById("questions_count");
  if (diffEl && countEl && COUNT_DIFFICULTY_MAP[countEl.value]) {
    diffEl.value = COUNT_DIFFICULTY_MAP[countEl.value];
  }
  updateEstimatedDuration();
}

document.addEventListener("DOMContentLoaded", () => {
  restoreSavedConfig();

  const diffEl = document.getElementById("difficulty");
  if (diffEl) {
    diffEl.addEventListener("change", handleDifficultyChange);
  }

  const countEl = document.getElementById("questions_count");
  if (countEl) {
    countEl.addEventListener("change", handleCountChange);
  }

  // Initial sync
  if (diffEl && countEl) {
    countEl.value = DIFFICULTY_COUNT_MAP[diffEl.value] || "20";
  }
  updateEstimatedDuration();
});

function handleLogout() {
  ApiService.logout();
}
