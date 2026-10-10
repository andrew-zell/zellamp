import type { AboutApi, SetupApi, SpotifyApi, ThemesApi, WidgetApi } from '../preload'

declare global {
  interface Window {
    spotify: SpotifyApi
    widget: WidgetApi
    themes: ThemesApi
    setup: SetupApi
    about: AboutApi
  }
}
