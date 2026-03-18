import { invoke } from "@tauri-apps/api/core";

type AppSettings = {
  directoryPath: string;
  intervalSeconds: number;
  foregroundNudgeEnabled: boolean;
  foregroundNudgeIntervalMinutes: number;
  imageMaximized: boolean;
};

type AppState = {
  currentImageIndex: number | null;
  imagePaths: string[];
  imageRequestToken: number;
  isImageMaximized: boolean;
  settings: AppSettings;
  shuffledOrder: number[];
  shufflePosition: number;
  timerId: number | null;
};

const state: AppState = {
  currentImageIndex: null,
  imagePaths: [],
  imageRequestToken: 0,
  isImageMaximized: false,
  settings: {
    directoryPath: "",
    intervalSeconds: 30,
    foregroundNudgeEnabled: true,
    foregroundNudgeIntervalMinutes: 1,
    imageMaximized: false,
  },
  shuffledOrder: [],
  shufflePosition: 0,
  timerId: null,
};

const elements = {
  appShell: document.querySelector<HTMLElement>(".app-shell"),
  currentImageName: document.querySelector<HTMLElement>("#current-image-name"),
  emptyMessage: document.querySelector<HTMLElement>("#empty-message"),
  imageCounter: document.querySelector<HTMLElement>("#image-counter"),
  intervalInput: document.querySelector<HTMLInputElement>("#interval-seconds"),
  foregroundNudgeEnabledInput: document.querySelector<HTMLInputElement>(
    "#foreground-nudge-enabled",
  ),
  foregroundNudgeIntervalInput: document.querySelector<HTMLInputElement>(
    "#foreground-nudge-interval-minutes",
  ),
  nextOverlayButton: document.querySelector<HTMLButtonElement>("#next-image-overlay"),
  photo: document.querySelector<HTMLImageElement>("#photo"),
  photoStage: document.querySelector<HTMLElement>("#photo-stage"),
  restoreLayoutButton: document.querySelector<HTMLButtonElement>("#restore-layout"),
  settingsButton: document.querySelector<HTMLButtonElement>("#open-settings"),
  settingsDialog: document.querySelector<HTMLDialogElement>("#settings-dialog"),
  settingsForm: document.querySelector<HTMLFormElement>("#settings-form"),
  settingsStatus: document.querySelector<HTMLElement>("#settings-status"),
  directoryInput: document.querySelector<HTMLInputElement>("#directory-path"),
  viewerStatus: document.querySelector<HTMLElement>("#viewer-status"),
};

function requireElement<T>(element: T | null, selector: string): T {
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

const appShell = requireElement(elements.appShell, ".app-shell");
const currentImageName = requireElement(elements.currentImageName, "#current-image-name");
const emptyMessage = requireElement(elements.emptyMessage, "#empty-message");
const imageCounter = requireElement(elements.imageCounter, "#image-counter");
const intervalInput = requireElement(elements.intervalInput, "#interval-seconds");
const foregroundNudgeEnabledInput = requireElement(
  elements.foregroundNudgeEnabledInput,
  "#foreground-nudge-enabled",
);
const foregroundNudgeIntervalInput = requireElement(
  elements.foregroundNudgeIntervalInput,
  "#foreground-nudge-interval-minutes",
);
const nextOverlayButton = requireElement(elements.nextOverlayButton, "#next-image-overlay");
const photo = requireElement(elements.photo, "#photo");
const photoStage = requireElement(elements.photoStage, "#photo-stage");
const restoreLayoutButton = requireElement(elements.restoreLayoutButton, "#restore-layout");
const settingsButton = requireElement(elements.settingsButton, "#open-settings");
const settingsDialog = requireElement(elements.settingsDialog, "#settings-dialog");
const settingsForm = requireElement(elements.settingsForm, "#settings-form");
const settingsStatus = requireElement(elements.settingsStatus, "#settings-status");
const directoryInput = requireElement(elements.directoryInput, "#directory-path");
const viewerStatus = requireElement(elements.viewerStatus, "#viewer-status");

let foregroundNudgeTimerId: number | null = null;

function stopForegroundNudgeTimer() {
  if (foregroundNudgeTimerId !== null) {
    window.clearInterval(foregroundNudgeTimerId);
    foregroundNudgeTimerId = null;
  }
}

function startForegroundNudgeTimer() {
  stopForegroundNudgeTimer();

  if (!state.settings.foregroundNudgeEnabled) {
    return;
  }

  if (document.hasFocus()) {
    return;
  }

  const intervalMs = state.settings.foregroundNudgeIntervalMinutes * 60 * 1000;
  foregroundNudgeTimerId = window.setInterval(() => {
    void invoke("raise_window_without_focus").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setViewerStatus(message, true);
      stopForegroundNudgeTimer();
    });
  }, intervalMs);
}

function restartForegroundNudgeTimer() {
  if (!state.settings.foregroundNudgeEnabled) {
    stopForegroundNudgeTimer();
    return;
  }

  if (document.hasFocus()) {
    stopForegroundNudgeTimer();
    return;
  }

  startForegroundNudgeTimer();
}

function setViewerMessage(message: string) {
  emptyMessage.textContent = message;
  photoStage.dataset.empty = "true";
  photo.hidden = true;
}

function clearViewerMessage() {
  photoStage.dataset.empty = "false";
  photo.hidden = false;
}

function setSettingsStatus(message: string, isError = false) {
  settingsStatus.textContent = message;
  settingsStatus.dataset.error = isError ? "true" : "false";
}

function setViewerStatus(message: string, isError = false) {
  viewerStatus.textContent = message;
  viewerStatus.dataset.error = isError ? "true" : "false";
}

function syncImageMaximizedState() {
  appShell.dataset.imageMaximized = state.isImageMaximized ? "true" : "false";
  const buttonLabel = state.isImageMaximized
    ? "Exit max image mode"
    : "Enter max image mode";

  restoreLayoutButton.setAttribute("aria-label", buttonLabel);
  restoreLayoutButton.title = buttonLabel;
}

function setImageMaximized(isMaximized: boolean) {
  state.isImageMaximized = isMaximized;
  syncImageMaximizedState();
}

async function persistSettings() {
  const savedSettings = await invoke<AppSettings>("save_settings", {
    settings: state.settings,
  });

  state.settings = savedSettings;
}

function resetTimer() {
  if (state.timerId !== null) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function updateImageCounter() {
  if (state.imagePaths.length === 0 || state.currentImageIndex === null) {
    imageCounter.textContent = "0 images";
    return;
  }

  imageCounter.textContent = `${state.currentImageIndex + 1} of ${state.imagePaths.length}`;
}

function buildShuffledOrder(length: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function nextShuffledIndex(): number {
  if (state.shufflePosition >= state.shuffledOrder.length) {
    state.shuffledOrder = buildShuffledOrder(state.imagePaths.length);
    state.shufflePosition = 0;
  }
  return state.shuffledOrder[state.shufflePosition++];
}

async function renderCurrentImage(index: number) {
  const imagePath = state.imagePaths[index];
  const fileName = imagePath.split(/[/\\]/).pop() ?? imagePath;
  const requestToken = state.imageRequestToken + 1;

  state.imageRequestToken = requestToken;
  setViewerStatus(`Loading ${fileName}...`);

  const imageSource = await invoke<string>("load_image_data_url", { imagePath });
  if (requestToken !== state.imageRequestToken) {
    return;
  }

  state.currentImageIndex = index;
  photo.src = imageSource;
  photo.alt = fileName;
  currentImageName.textContent = fileName;
  clearViewerMessage();
  updateImageCounter();
  setViewerStatus(`Showing ${fileName}`);
}

async function showRandomImage() {
  if (state.imagePaths.length === 0) {
    state.currentImageIndex = null;
    currentImageName.textContent = "No image selected";
    updateImageCounter();
    setViewerMessage("Choose a directory in Settings to begin the slideshow.");
    setViewerStatus("No images loaded.");
    return;
  }

  const nextIndex = nextShuffledIndex();
  try {
    await renderCurrentImage(nextIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setViewerMessage("The selected image could not be displayed.");
    setViewerStatus(message, true);
  }
}

function restartSlideshow() {
  resetTimer();

  if (state.imagePaths.length === 0) {
    return;
  }

  state.timerId = window.setInterval(() => {
    void showRandomImage();
  }, state.settings.intervalSeconds * 1000);
}

async function advanceToNextImage() {
  await showRandomImage();
  restartSlideshow();
}

async function refreshImages() {
  const directoryPath = state.settings.directoryPath.trim();

  if (!directoryPath) {
    state.imagePaths = [];
    state.currentImageIndex = null;
    currentImageName.textContent = "No directory configured";
    setViewerMessage("Set an image directory in Settings.");
    setViewerStatus("Waiting for configuration.");
    updateImageCounter();
    resetTimer();
    return;
  }

  const imagePaths = await invoke<string[]>("scan_images", { directoryPath });
  state.imagePaths = imagePaths;
  state.currentImageIndex = null;
  state.shuffledOrder = buildShuffledOrder(imagePaths.length);
  state.shufflePosition = 0;

  if (imagePaths.length === 0) {
    currentImageName.textContent = "No supported images found";
    setViewerMessage("No .jpg, .jpeg, .gif, .png, or .webp files were found in the selected directory.");
    setViewerStatus("Directory scanned, but it contained no supported images.");
    updateImageCounter();
    resetTimer();
    return;
  }

  await advanceToNextImage();
}

function syncForegroundNudgeInputState() {
  foregroundNudgeIntervalInput.disabled = !foregroundNudgeEnabledInput.checked;
}

function syncFormFromState() {
  directoryInput.value = state.settings.directoryPath;
  intervalInput.value = String(state.settings.intervalSeconds);
  foregroundNudgeEnabledInput.checked = state.settings.foregroundNudgeEnabled;
  foregroundNudgeIntervalInput.value = String(state.settings.foregroundNudgeIntervalMinutes);
  syncForegroundNudgeInputState();
}

async function initializeApp() {
  try {
    state.settings = await invoke<AppSettings>("load_settings");
    setImageMaximized(state.settings.imageMaximized);
    syncFormFromState();
    await refreshImages();
    restartForegroundNudgeTimer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setViewerMessage("The application settings could not be loaded.");
    setViewerStatus(message, true);
    setSettingsStatus(message, true);
  }
}

settingsButton.addEventListener("click", () => {
  syncFormFromState();
  setSettingsStatus("Update settings, then save.");
  settingsDialog.showModal();
});

settingsDialog.addEventListener("close", () => {
  setSettingsStatus("");
});

nextOverlayButton.addEventListener("click", () => {
  void advanceToNextImage();
});

restoreLayoutButton.addEventListener("click", () => {
  const nextImageMaximized = !state.isImageMaximized;
  setImageMaximized(nextImageMaximized);
  state.settings.imageMaximized = nextImageMaximized;

  void persistSettings().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setViewerStatus(message, true);
  });
});

photo.addEventListener("error", () => {
  setViewerMessage("The current image failed to load.");
  setViewerStatus("Image decoding failed in the webview.", true);
});

foregroundNudgeEnabledInput.addEventListener("change", () => {
  syncForegroundNudgeInputState();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const intervalSeconds = Number.parseInt(intervalInput.value, 10);
  const foregroundNudgeEnabled = foregroundNudgeEnabledInput.checked;
  const foregroundNudgeIntervalMinutes = Number.parseInt(
    foregroundNudgeIntervalInput.value,
    10,
  );

  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    setSettingsStatus("Interval must be a whole number of at least 1 second.", true);
    return;
  }

  if (
    foregroundNudgeEnabled
    && (!Number.isInteger(foregroundNudgeIntervalMinutes) || foregroundNudgeIntervalMinutes < 1)
  ) {
    setSettingsStatus(
      "Foreground nudge interval must be a whole number of at least 1 minute.",
      true,
    );
    return;
  }

  try {
    state.settings.directoryPath = directoryInput.value.trim();
    state.settings.intervalSeconds = intervalSeconds;
    state.settings.foregroundNudgeEnabled = foregroundNudgeEnabled;
    if (foregroundNudgeEnabled) {
      state.settings.foregroundNudgeIntervalMinutes = foregroundNudgeIntervalMinutes;
    }
    await persistSettings();
    syncFormFromState();
    restartForegroundNudgeTimer();
    await refreshImages();
    settingsDialog.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSettingsStatus(message, true);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  void initializeApp();
});

window.addEventListener("blur", () => {
  startForegroundNudgeTimer();
});

window.addEventListener("focus", () => {
  stopForegroundNudgeTimer();
});
