import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type AppSettings = {
  directoryPath: string;
  intervalSeconds: number;
};

type AppState = {
  currentImageIndex: number | null;
  imagePaths: string[];
  settings: AppSettings;
  timerId: number | null;
};

const state: AppState = {
  currentImageIndex: null,
  imagePaths: [],
  settings: {
    directoryPath: "",
    intervalSeconds: 30,
  },
  timerId: null,
};

const elements = {
  currentImageName: document.querySelector<HTMLElement>("#current-image-name"),
  emptyMessage: document.querySelector<HTMLElement>("#empty-message"),
  imageCounter: document.querySelector<HTMLElement>("#image-counter"),
  intervalInput: document.querySelector<HTMLInputElement>("#interval-seconds"),
  photo: document.querySelector<HTMLImageElement>("#photo"),
  photoStage: document.querySelector<HTMLElement>("#photo-stage"),
  settingsButton: document.querySelector<HTMLButtonElement>("#open-settings"),
  settingsDialog: document.querySelector<HTMLDialogElement>("#settings-dialog"),
  settingsForm: document.querySelector<HTMLFormElement>("#settings-form"),
  settingsStatus: document.querySelector<HTMLElement>("#settings-status"),
  directoryInput: document.querySelector<HTMLInputElement>("#directory-path"),
  shuffleButton: document.querySelector<HTMLButtonElement>("#shuffle-now"),
  viewerStatus: document.querySelector<HTMLElement>("#viewer-status"),
};

function requireElement<T>(element: T | null, selector: string): T {
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

const currentImageName = requireElement(elements.currentImageName, "#current-image-name");
const emptyMessage = requireElement(elements.emptyMessage, "#empty-message");
const imageCounter = requireElement(elements.imageCounter, "#image-counter");
const intervalInput = requireElement(elements.intervalInput, "#interval-seconds");
const photo = requireElement(elements.photo, "#photo");
const photoStage = requireElement(elements.photoStage, "#photo-stage");
const settingsButton = requireElement(elements.settingsButton, "#open-settings");
const settingsDialog = requireElement(elements.settingsDialog, "#settings-dialog");
const settingsForm = requireElement(elements.settingsForm, "#settings-form");
const settingsStatus = requireElement(elements.settingsStatus, "#settings-status");
const directoryInput = requireElement(elements.directoryInput, "#directory-path");
const shuffleButton = requireElement(elements.shuffleButton, "#shuffle-now");
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

function renderCurrentImage(index: number) {
  const imagePath = state.imagePaths[index];
  const fileName = imagePath.split(/[/\\]/).pop() ?? imagePath;

  state.currentImageIndex = index;
  photo.src = convertFileSrc(imagePath);
  photo.alt = fileName;
  currentImageName.textContent = fileName;
  clearViewerMessage();
  updateImageCounter();
  setViewerStatus(`Showing ${fileName}`);
}

function showRandomImage() {
  if (state.imagePaths.length === 0) {
    state.currentImageIndex = null;
    currentImageName.textContent = "No image selected";
    updateImageCounter();
    setViewerMessage("Choose a directory in Settings to begin the slideshow.");
    setViewerStatus("No images loaded.");
    return;
  }

  const nextIndex = chooseRandomIndex(state.imagePaths.length, state.currentImageIndex);
  renderCurrentImage(nextIndex);
}

function restartSlideshow() {
  resetTimer();

  if (state.imagePaths.length === 0) {
    return;
  }

  state.timerId = window.setInterval(() => {
    showRandomImage();
  }, state.settings.intervalSeconds * 1000);
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

  showRandomImage();
  restartSlideshow();
}

function syncFormFromState() {
  directoryInput.value = state.settings.directoryPath;
  intervalInput.value = String(state.settings.intervalSeconds);
}

async function initializeApp() {
  try {
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

shuffleButton.addEventListener("click", () => {
  showRandomImage();
  restartSlideshow();
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
