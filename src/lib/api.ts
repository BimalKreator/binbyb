import axios, { type AxiosError } from "axios";

// Exactly "/api" for secure domain (Nginx proxy); no trailing slash
const baseURL = "/api";

export const api = axios.create({
  baseURL,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

const TOKEN_KEY = "binbyb_jwt";

/** Socket origin: never return raw IP; use HTTPS domain when page is secure to avoid Mixed Content. */
export function getSocketOrigin(): string {
  if (typeof window !== "undefined") {
    if (window.location.protocol === "https:") {
      return "https://tradeictearner.online";
    }
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_API_URL || "https://tradeictearner.online";
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      setStoredToken(null);
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
