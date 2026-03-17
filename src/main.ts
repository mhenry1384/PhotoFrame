import { invoke } from "@tauri-apps/api/core";

type AppSettings = {
  directoryPath: string;
  intervalSeconds: number;
};

type AppState = {
  currentImageIndex: number | null;
  imagePaths: string[];
  imageRequestToken: number;
  isImageMaximized: boolean;
  settings: AppSettings;
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
  },
  timerId: null,
};

const elements = {
  appShell: document.querySelector<HTMLElement>(".app-shell"),
  currentImageName: document.querySelector<HTMLElement>("#current-image-name"),
  emptyMessage: document.querySelector<HTMLElement>("#empty-message"),
  imageCounter: document.querySelector<HTMLElement>("#image-counter"),
  intervalInput: document.querySelector<HTMLInputElement>("#interval-seconds"),
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

function chooseRandomIndex(length: number, excludeIndex: number | null): number {
  if (length <= 1 || excludeIndex === null) {
    return Math.floor(Math.random() * length);
  }

  let nextIndex = excludeIndex;
  while (nextIndex === excludeIndex) {
    nextIndex = Math.floor(Math.random() * length);
  }

  return nextIndex;
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

  const nextIndex = chooseRandomIndex(state.imagePaths.length, state.currentImageIndex);
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

function syncFormFromState() {
  directoryInput.value = state.settings.directoryPath;
  intervalInput.value = String(state.settings.intervalSeconds);
}

async function initializeApp() {
  try {
    syncImageMaximizedState();
    state.settings = await invoke<AppSettings>("load_settings");
    syncFormFromState();
    await refreshImages();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setViewerMessage("The application settings could not be loaded.");
    setViewerStatus(message, true);
    setSettingsStatus(message, true);
  }
}

settingsButton.addEventListener("click", () => {
  syncFormFromState();
  setSettingsStatus("Update the directory path and interval, then save.");
  settingsDialog.showModal();
});

settingsDialog.addEventListener("close", () => {
  setSettingsStatus("");
});

nextOverlayButton.addEventListener("click", () => {
  void advanceToNextImage();
});

restoreLayoutButton.addEventListener("click", () => {
  setImageMaximized(!state.isImageMaximized);
});

photo.addEventListener("error", () => {
  setViewerMessage("The current image failed to load.");
  setViewerStatus("Image decoding failed in the webview.", true);
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const intervalSeconds = Number.parseInt(intervalInput.value, 10);

  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    setSettingsStatus("Interval must be a whole number of at least 1 second.", true);
    return;
  }

  try {
    const savedSettings = await invoke<AppSettings>("save_settings", {
      settings: {
        directoryPath: directoryInput.value.trim(),
        intervalSeconds,
      },
    });

    state.settings = savedSettings;
    syncFormFromState();
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
