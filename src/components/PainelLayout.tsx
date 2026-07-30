import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { getConfig, setConfig } from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function PainelLayout({ children }: { children: ReactNode }) {
  const [pronto, setPronto] = useState(false);
  const [configurado, setConfigurado] = useState(false);
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");

  useEffect(() => {
    setConfigurado(Boolean(getConfig()));
    setPronto(true);
  }, []);

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-base font-semibold text-foreground">
            JVA Sistemas
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {!pronto ? null : configurado ? (
          children
        ) : (
          <div className="mx-auto max-w-md space-y-4 rounded-lg border bg-card p-6">
            <div>
              <h1 className="text-lg font-semibold text-foreground">Conectar ao Supabase</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Informe a URL e a chave anon do seu projeto Supabase para usar o painel.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="url">Supabase URL</Label>
              <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="key">Anon key</Label>
              <Input id="key" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} placeholder="eyJ..." />
            </div>
            <Button
              className="w-full"
              disabled={!url.trim() || !anonKey.trim()}
              onClick={() => {
                setConfig({ url: url.trim(), anonKey: anonKey.trim() });
                setConfigurado(true);
              }}
            >
              Conectar
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
