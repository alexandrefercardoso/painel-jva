import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-base font-semibold text-foreground">
            JVA Sistemas
          </Link>
          <button
            onClick={() => {
              // Como não há auth real no momento, apenas simulamos a saída redirecionando
              window.location.href = "https://www.google.com";
            }}
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Sair
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
