export {};

declare global {
  interface Window {
    __instaLikesBridgeInstalled?: boolean;
  }

  interface XMLHttpRequest {
    __instaLikesUrl?: string;
  }
}
