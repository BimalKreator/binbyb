import axios, { type AxiosError } from "axios";

// Backend API base: set NEXT_PUBLIC_API_URL (e.g. http://139.180.190.25:5000) or fallback to hardcoded backend URL
const API_ORIGIN =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) || "http://139.180.190.25:5000";
const API_ORIGIN_CLEAN = String(API_ORIGIN).replace(/\/$/, "");
const baseURL = `${API_ORIGIN_CLEAN}/api`;

export const api = axios.create({
  baseURL,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

const TOKEN_KEY = "binbyb_jwt";

/** Backend origin for Socket.io (same as API server, no /api path). */
export const getSocketOrigin = (): string => {
  return API_ORIGIN_CLEAN;
};

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
