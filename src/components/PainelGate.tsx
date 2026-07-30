import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { getConfig, setConfig } from "@/lib/painel-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">JVA Sistemas</h1>
        <p className="mb-4 text-sm text-muted-foreground">{title}</p>
        {children}
      </div>
    </div>
  );
}

function ConfigForm({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setConfig({ url: url.trim(), anonKey: anonKey.trim() });
        onDone();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="url">URL do Supabase</Label>
        <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="key">Chave anon</Label>
        <Input id="key" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} placeholder="eyJ... / sb_publishable_..." required />
      </div>
      <Button type="submit" className="w-full">
        Conectar
      </Button>
    </form>
  );
}

export function PainelGate({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<"carregando" | "config" | "ok">("carregando");

  const avaliar = () => setEstado(getConfig() ? "ok" : "config");

  useEffect(avaliar, []);

  if (estado === "carregando") return null;
  if (estado === "config")
    return (
      <Card title="Conecte o painel ao seu projeto Supabase existente.">
        <ConfigForm onDone={avaliar} />
      </Card>
    );

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-base font-semibold text-foreground">
            JVA Sistemas
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
