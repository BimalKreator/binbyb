import { create } from "zustand";
import { getStoredToken, setStoredToken } from "@/lib/api";

type User = { email: string; role: string } | null;

type AuthState = {
  token: string | null;
  user: User;
  isHydrated: boolean;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
  hydrate: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  isHydrated: false,
  setAuth: (token, user) => {
    setStoredToken(token);
    set({ token, user });
  },
  logout: () => {
    setStoredToken(null);
    set({ token: null, user: null });
  },
  hydrate: () => {
    const token = getStoredToken();
    if (token) {
      set({ token, isHydrated: true });
    } else {
      set({ token: null, user: null, isHydrated: true });
    }
  },
}));
