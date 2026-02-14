/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  readonly VITE_SPOTIFY_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }

  // https://developer.spotify.com/documentation/web-playback-sdk/reference
  namespace Spotify {
    class Player {
      constructor(options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      });
      connect(): Promise<boolean>;
      disconnect(): void;
      addListener(event: string, cb: (arg: unknown) => void): void;
      removeListener(event: string, cb?: (arg: unknown) => void): void;
      getCurrentState(): Promise<unknown>;
      setName(name: string): Promise<void>;
      getVolume(): Promise<number>;
      setVolume(volume: number): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      togglePlay(): Promise<void>;
      seek(position_ms: number): Promise<void>;
      previousTrack(): Promise<void>;
      nextTrack(): Promise<void>;
      activateElement(): Promise<void>;
    }
  }
}

export {};
