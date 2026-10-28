"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

const TOKEN_KEY = "syntropic_access_token";

type AuthContextType = {
  token: string;
  setToken: (token: string) => void;
  isAuthenticated: boolean;
};

const AuthContext = createContext<AuthContextType>({
  token: "",
  setToken: () => {},
  isAuthenticated: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState("");

  useEffect(() => {
    setTokenState(window.sessionStorage.getItem(TOKEN_KEY) ?? "");
  }, []);

  const setToken = (value: string) => {
    setTokenState(value.trim());
    if (value.trim()) {
      window.sessionStorage.setItem(TOKEN_KEY, value.trim());
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  };

  return (
    <AuthContext.Provider
      value={{ token, setToken, isAuthenticated: Boolean(token) }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
