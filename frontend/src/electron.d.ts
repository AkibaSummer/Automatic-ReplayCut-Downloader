export {}

declare global {
  interface Window {
    desktopAPI?: {
      getBackendBaseURL?: () => Promise<string>
      quitApp?: () => Promise<void>
    }
  }
}
