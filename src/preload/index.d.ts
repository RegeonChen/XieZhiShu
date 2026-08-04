export interface AppApi {
  getAppInfo(): Promise<{ version: string; platform: string }>
}

declare global {
  interface Window {
    api: AppApi
  }
}
