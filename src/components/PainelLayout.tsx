import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
          <Link to="/" className="text-base font-semibold text-foreground">
            JVA Sistemas
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/produtos" className="text-muted-foreground hover:text-foreground" activeProps={{ className: "text-foreground font-medium" }}>
              Produtos
            </Link>
            <Link to="/modulos" className="text-muted-foreground hover:text-foreground" activeProps={{ className: "text-foreground font-medium" }}>
              Módulos
            </Link>
            <Link to="/backup" className="text-muted-foreground hover:text-foreground" activeProps={{ className: "text-foreground font-medium" }}>
              Backup
            </Link>
          </nav>
        </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
