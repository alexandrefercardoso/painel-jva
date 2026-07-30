import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { getConfig, setConfig, getSession, clearSession, login } from "@/lib/painel-db";
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

function LoginForm({ onDone }: { onDone: () => void }) {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setCarregando(true);
        setErro(null);
        try {
          await login(usuario, senha);
          onDone();
        } catch (err) {
          setErro(err instanceof Error ? err.message : "Falha no login.");
        } finally {
          setCarregando(false);
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="usuario">Usuário</Label>
        <Input id="usuario" value={usuario} onChange={(e) => setUsuario(e.target.value)} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="senha">Senha</Label>
        <Input id="senha" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
      </div>
      {erro && <p className="text-sm text-destructive">{erro}</p>}
      <Button type="submit" className="w-full" disabled={carregando}>
        {carregando ? "Entrando..." : "Entrar"}
      </Button>
    </form>
  );
}

export function PainelGate({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<"carregando" | "config" | "login" | "ok">("carregando");

  const avaliar = () => {
    if (!getConfig()) setEstado("config");
    else if (!getSession()) setEstado("login");
    else setEstado("ok");
  };

  useEffect(avaliar, []);

  if (estado === "carregando") return null;
  if (estado === "config")
    return (
      <Card title="Conecte o painel ao seu projeto Supabase existente.">
        <ConfigForm onDone={avaliar} />
      </Card>
    );
  if (estado === "login")
    return (
      <Card title="Acesso ao painel de gestão.">
        <LoginForm onDone={avaliar} />
      </Card>
    );

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-base font-semibold text-foreground">
            JVA Sistemas
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearSession();
              avaliar();
            }}
          >
            Sair
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
