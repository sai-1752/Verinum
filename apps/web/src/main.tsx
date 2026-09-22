import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ApiError } from "./lib/api";
import { AuthProvider } from "./lib/auth";
import { initTheme } from "./lib/theme";
import { ToastProvider } from "./lib/toast";
import "./styles.css";

initTheme();

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000, refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <AuthProvider><App /></AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
