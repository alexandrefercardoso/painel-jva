import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Database,
  Eye,
  FileCode2,
  Loader2,
  Play,
  PlugZap,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { PainelLayout } from "@/components/PainelLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import {
  alvosApi,
  erroMensagemSql,
  executorApi,
  sessaoSql,
  type AlvoSql,
  type ResultadoAlvoSql,
  type ResultadoTesteSql,
} from "@/lib/sql-api";

export const Route = createFileRoute("/sql")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "SQL Multi-Banco — JVA Sistemas" },
      {
        name: "description",
        content: "Aplica um único script SQL em várias instâncias Supabase de uma vez.",
      },
    ],
  }),
  component: () => (
    <PainelLayout>
      <ModuloSql />
    </PainelLayout>
  ),
});

// ---------------------------------------------------------------------------
// Sessão + gate administrativo (mesma sessão do módulo de Backup)
// ---------------------------------------------------------------------------
function ModuloSql() {
  const [sessao, setSessao] = useState<Awaited<ReturnType<typeof sessaoSql.atual>> | null>(null);
  const [verificando, setVerificando] = useState(true);

  const consultarSessao = useCallback(async () => {
    try {
      setSessao(await sessaoSql.atual());
    } catch (e) {
      toast.error(erroMensagemSql(e));
    } finally {
      setVerificando(false);
    }
  }, []);

  useEffect(() => {
    consultarSessao();
  }, [consultarSessao]);

  if (verificando) {
    return <p className="py-20 text-center text-sm text-muted-foreground">Verificando sessão…</p>;
  }
  if (!sessao) {
    return (
      <p className="py-20 text-center text-sm text-muted-foreground">
        Não foi possível verificar a sessão.
      </p>
    );
  }
  if (sessao.backendProblema) {
    return (
      <Alert variant="destructive">
        <ShieldCheck className="size-4" />
        <AlertTitle>Backend não configurado</AlertTitle>
        <AlertDescription>{sessao.backendProblema}</AlertDescription>
      </Alert>
    );
  }
  if (!sessao.autenticado) {
    return <TelaLogin onLogado={consultarSessao} />;
  }
  return <AdminSql onSair={consultarSessao} />;
}

function TelaLogin({ onLogado }: { onLogado: () => void }) {
  const [senha, setSenha] = useState("");
  const [entrando, setEntrando] = useState(false);

  const entrar = async (evento: React.FormEvent) => {
    evento.preventDefault();
    setEntrando(true);
    try {
      await sessaoSql.login(senha);
      onLogado();
    } catch (e) {
      toast.error(erroMensagemSql(e));
    } finally {
      setEntrando(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm py-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> Acesso administrativo
          </CardTitle>
          <CardDescription>
            SQL Multi-Banco é um módulo exclusivo da administração. Mesma senha do módulo de Backup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={entrar} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="senha">Senha de administrador</Label>
              <Input
                id="senha"
                type="password"
                autoComplete="current-password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={entrando}>
              {entrando ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contador aproximado de comandos (descarta comentários, strings e $$..$$)
// ---------------------------------------------------------------------------
function estimarComandos(script: string): number {
  let limpo = script
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
  limpo = limpo.replace(/;/g, ";");
  const n = (limpo.match(/;/g) ?? []).length;
  const semFim = limpo.trim().length > 0 && n === 0;
  return semFim ? 1 : n;
}

// ---------------------------------------------------------------------------
// Scripts salvos (localStorage — sem migração no banco)
// ---------------------------------------------------------------------------
type ScriptSalvo = { nome: string; sql: string; criado_em: string };
const CHAVE_SCRIPTS = "jva.sql.scripts";

function carregarScriptsSalvos(): ScriptSalvo[] {
  try {
    const raw = window.localStorage.getItem(CHAVE_SCRIPTS);
    return raw ? (JSON.parse(raw) as ScriptSalvo[]) : [];
  } catch {
    return [];
  }
}

function salvarScriptsSalvos(lista: ScriptSalvo[]) {
  window.localStorage.setItem(CHAVE_SCRIPTS, JSON.stringify(lista));
}

// ---------------------------------------------------------------------------
// Painel principal
// ---------------------------------------------------------------------------
type EstadoAlvo =
  | { fase: "aguardando" }
  | { fase: "executando" }
  | { fase: "concluido"; resultado: ResultadoAlvoSql };

function AdminSql({ onSair }: { onSair: () => void }) {
  const [alvos, setAlvos] = useState<AlvoSql[]>([]);
  const [carregando, setCarregando] = useState(true);

  const [script, setScript] = useState("");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [transacao, setTransacao] = useState(true);
  const [timeoutSeg, setTimeoutSeg] = useState(120);

  const [estadoAlvos, setEstadoAlvos] = useState<Record<string, EstadoAlvo>>({});
  const [rodando, setRodando] = useState(false);

  const [diálogoExecutar, setDiálogoExecutar] = useState(false);
  const [confirmacaoTexto, setConfirmacaoTexto] = useState("");

  const [salvos, setSalvos] = useState<ScriptSalvo[]>([]);
  const [nomeSalvo, setNomeSalvo] = useState("");

  const carregarAlvos = useCallback(async () => {
    setCarregando(true);
    try {
      const lista = await alvosApi.listar();
      setAlvos(lista);
      setSelecionados((atual) => {
        const ids = new Set(lista.map((a) => a.id));
        return new Set([...atual].filter((id) => ids.has(id)));
      });
    } catch (e) {
      toast.error(erroMensagemSql(e));
      setAlvos([]);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarAlvos();
    setSalvos(carregarScriptsSalvos());
  }, [carregarAlvos]);

  const gruposPorAmbiente = useMemo(() => {
    const ordem = ["producao", "homologacao", "desenvolvimento"] as const;
    const mapa = new Map<string, AlvoSql[]>();
    for (const a of alvos) {
      const lista = mapa.get(a.ambiente) ?? [];
      lista.push(a);
      mapa.set(a.ambiente, lista);
    }
    return ordem
      .filter((amb) => mapa.has(amb))
      .map((amb) => ({ ambiente: amb, alvos: mapa.get(amb)! }));
  }, [alvos]);

  const ROTULO_AMBIENTE: Record<string, string> = {
    producao: "Produção",
    homologacao: "Homologação",
    desenvolvimento: "Desenvolvimento",
  };

  const alternar = (id: string, marcado: boolean) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (marcado) novo.add(id);
      else novo.delete(id);
      return novo;
    });
  };

  const alternarGrupo = (lista: AlvoSql[], marcado: boolean) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      for (const a of lista) {
        if (marcado) novo.add(a.id);
        else novo.delete(a.id);
      }
      return novo;
    });
  };

  const podeEnviar = script.trim().length > 0 && selecionados.size > 0 && !rodando;

  // -------------------------------------------------------------------------
  // Teste (rollback) e execução definitiva
  // -------------------------------------------------------------------------
  const prepararResultadosIniciais = () => {
    const inicial: Record<string, EstadoAlvo> = {};
    for (const id of selecionados) inicial[id] = { fase: "aguardando" };
    setEstadoAlvos(inicial);
  };

  const aplicarResultado = (resultados: ResultadoAlvoSql[]) => {
    setEstadoAlvos((atual) => {
      const novo = { ...atual };
      for (const r of resultados) {
        novo[r.id] = { fase: "concluido", resultado: r };
      }
      return novo;
    });
  };

  const rodarTeste = async () => {
    if (!podeEnviar) return;
    setRodando(true);
    prepararResultadosIniciais();
    try {
      const resposta = await executorApi.teste({
        sql: script,
        alvos: [...selecionados],
        transacao,
        timeout_seg: timeoutSeg,
      });
      aplicarResultado(resposta.resultados);
      const falhas = resposta.resultados.filter((r) => r.status === "falha").length;
      if (falhas === 0) {
        toast.success(
          `Teste ok em ${resposta.resultados.length} banco(s) — transações descartadas (nada foi persistido).`,
        );
      } else {
        toast.warning(
          `Teste concluído: ${resposta.resultados.length - falhas} ok, ${falhas} com erro.`,
        );
      }
    } catch (e) {
      toast.error(erroMensagemSql(e));
      setEstadoAlvos({});
    } finally {
      setRodando(false);
    }
  };

  const executarDefinitivo = async () => {
    if (!podeEnviar) return;
    setDiálogoExecutar(false);
    setConfirmacaoTexto("");
    setRodando(true);
    prepararResultadosIniciais();
    try {
      const resposta = await executorApi.executar({
        sql: script,
        alvos: [...selecionados],
        confirmacao: "EXECUTAR",
        transacao,
        timeout_seg: timeoutSeg,
      });
      aplicarResultado(resposta.resultados);
      const ok = resposta.resultados.filter((r) => r.status === "ok").length;
      const falhas = resposta.resultados.length - ok;
      if (falhas === 0) {
        toast.success(`Script aplicado com sucesso em ${ok} banco(s)!`);
      } else if (ok === 0) {
        toast.error(`Falha em todos os ${falhas} banco(s) selecionados.`);
      } else {
        toast.warning(`Aplicado em ${ok} banco(s); ${falhas} com falha.`);
      }
    } catch (e) {
      toast.error(erroMensagemSql(e));
      setEstadoAlvos({});
    } finally {
      setRodando(false);
    }
  };

  // -------------------------------------------------------------------------
  // Teste de conexão avulso por alvo
  // -------------------------------------------------------------------------
  const [testando, setTestando] = useState<Record<string, ResultadoTesteSql | "loading">>({});
  const testarConexao = async (id: string) => {
    setTestando((atual) => ({ ...atual, [id]: "loading" }));
    try {
      const r = await alvosApi.testar(id);
      setTestando((atual) => ({ ...atual, [id]: r }));
      if (r.ok) toast.success(`Conexão ok (${r.latencia_ms} ms).`);
      else toast.error(`Falha: ${r.detalhe}`);
    } catch (e) {
      setTestando((atual) => {
        const { [id]: _removido, ...resto } = atual;
        return resto;
      });
      toast.error(erroMensagemSql(e));
    }
  };

  // -------------------------------------------------------------------------
  // Scripts salvos
  // -------------------------------------------------------------------------
  const salvarScript = () => {
    const nome = nomeSalvo.trim();
    if (!nome || !script.trim()) {
      toast.error("Informe um nome e digite o script antes de salvar.");
      return;
    }
    const lista = [
      ...salvos.filter((s) => s.nome.toLowerCase() !== nome.toLowerCase()),
      { nome, sql: script, criado_em: new Date().toISOString() },
    ].sort((a, b) => a.nome.localeCompare(b.nome));
    setSalvos(lista);
    salvarScriptsSalvos(lista);
    setNomeSalvo("");
    toast.success(`Script "${nome}" salvo neste navegador.`);
  };

  const excluirScript = (nome: string) => {
    const lista = salvos.filter((s) => s.nome !== nome);
    setSalvos(lista);
    salvarScriptsSalvos(lista);
  };

  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">SQL Multi-Banco</h1>
          <p className="text-sm text-muted-foreground">
            Escreva o script uma vez e aplique de uma vez em todas as instâncias selecionadas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={carregarAlvos} disabled={carregando}>
            <RefreshCw className="size-4" /> Atualizar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await sessaoSql.logout();
                onSair();
              } catch (e) {
                toast.error(erroMensagemSql(e));
              }
            }}
          >
            Sair
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* -------------------------------------------------- coluna esquerda */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCode2 className="size-5 text-primary" /> Script SQL
              </CardTitle>
              <CardDescription>
                Comandos separados por ponto e vírgula; comentários (-- e /* */) são permitidos. ~
                {estimarComandos(script)} comando(s) estimado(s) ·{" "}
                {script.length.toLocaleString("pt-BR")} caracteres
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder={
                  "-- Exemplo:\nalter table public.clientes add column if not exists telefone text;\ncreate table if not exists public.configuracoes (id uuid primary key default gen_random_uuid());"
                }
                className="min-h-64 font-mono text-[13px] leading-relaxed"
                spellCheck={false}
                autoComplete="off"
              />

              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="salvar-nome" className="text-xs text-muted-foreground">
                    Salvar script neste navegador
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="salvar-nome"
                      value={nomeSalvo}
                      onChange={(e) => setNomeSalvo(e.target.value)}
                      placeholder="Ex.: adicionar coluna telefone"
                      className="h-8 w-56"
                    />
                    <Button variant="outline" size="sm" onClick={salvarScript} disabled={rodando}>
                      <Save className="size-4" /> Salvar
                    </Button>
                  </div>
                </div>
              </div>

              {salvos.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  {salvos.map((s) => (
                    <span
                      key={s.nome}
                      className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-1 pl-3 pr-1 text-xs"
                    >
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setScript(s.sql)}
                        title="Carregar no editor"
                      >
                        {s.nome}
                      </button>
                      <button
                        type="button"
                        className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => excluirScript(s.nome)}
                        title="Excluir script salvo"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ---------------------------------------------------- resultados */}
          {(rodando || Object.keys(estadoAlvos).length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Resultados por banco</CardTitle>
                <CardDescription>
                  Execução sequencial, um banco de cada vez — cada banco é independente.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {[...selecionados].map((id) => (
                  <ResultadoAlvo
                    key={id}
                    alvo={alvos.find((a) => a.id === id)}
                    estado={estadoAlvos[id]}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* -------------------------------------------------- coluna direita */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="size-5 text-primary" /> Bancos de destino
                <Badge variant="secondary" className="ml-auto">
                  {selecionados.size}/{alvos.length}
                </Badge>
              </CardTitle>
              <CardDescription>
                Instâncias ativas com credencial cadastrada (módulo de Backup).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {carregando && <p className="text-sm text-muted-foreground">Carregando…</p>}
              {!carregando && alvos.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nenhuma instância apta. Cadastre instâncias com credencial no módulo de Backup.
                </p>
              )}
              {gruposPorAmbiente.map(({ ambiente, alvos: lista }) => {
                const todosMarcados =
                  lista.length > 0 && lista.every((a) => selecionados.has(a.id));
                return (
                  <div key={ambiente} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                        {ROTULO_AMBIENTE[ambiente] ?? ambiente}
                      </Label>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => alternarGrupo(lista, !todosMarcados)}
                      >
                        {todosMarcados ? "desmarcar" : "selecionar grupo"}
                      </button>
                    </div>
                    {lista.map((a) => {
                      const teste = testando[a.id];
                      const estado = estadoAlvos[a.id];
                      return (
                        <label
                          key={a.id}
                          className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 hover:bg-muted/40"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selecionados.has(a.id)}
                              onChange={(e) => alternar(a.id, e.target.checked)}
                              className="size-4 accent-primary"
                            />
                            <span className="min-w-0 flex-col leading-tight">
                              <span className="block truncate text-sm font-medium">{a.nome}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {a.db_host} · {a.db_name}
                              </span>
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            {estado?.fase === "concluido" && estado.resultado.status === "ok" && (
                              <CheckCircle2 className="size-4 text-green-600" />
                            )}
                            {estado?.fase === "concluido" &&
                              estado.resultado.status === "falha" && (
                                <XCircle className="size-4 text-red-600" />
                              )}
                            {estado?.fase === "executando" && (
                              <Loader2 className="size-4 animate-spin text-primary" />
                            )}
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title="Testar conexão (SELECT 1)"
                              onClick={() => testarConexao(a.id)}
                            >
                              {teste === "loading" ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <PlugZap className="size-4" />
                              )}
                            </button>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Opções de execução</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">Tudo-ou-nada por banco</span>
                  <span className="text-xs text-muted-foreground">
                    Se um comando falhar, tudo é desfeito naquele banco.
                  </span>
                </div>
                <Switch checked={transacao} onCheckedChange={setTransacao} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-sm">Tempo limite por comando</Label>
                <select
                  value={timeoutSeg}
                  onChange={(e) => setTimeoutSeg(Number(e.target.value))}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value={30}>30 segundos</option>
                  <option value={120}>2 minutos</option>
                  <option value={300}>5 minutos</option>
                  <option value={600}>10 minutos</option>
                </select>
              </div>

              <div className="flex flex-col gap-2 border-t pt-3">
                <Button variant="secondary" onClick={rodarTeste} disabled={!podeEnviar}>
                  {rodando ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Processando…
                    </>
                  ) : (
                    <>
                      <Eye className="size-4" /> 1. Testar nos bancos (rollback)
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setDiálogoExecutar(true)}
                  disabled={!podeEnviar}
                >
                  <Play className="size-4" /> 2. Executar em definitivo
                </Button>
                <p className="text-xs text-muted-foreground">
                  Recomendação: use o teste primeiro — nada é persistido; depois confirme a
                  execução.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ------------------------------------------------ diálogo destrutivo */}
      <Dialog open={diálogoExecutar} onOpenChange={setDiálogoExecutar}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="size-5" /> Executar em definitivo
            </DialogTitle>
            <DialogDescription>
              O script será aplicado em <strong>{selecionados.size}</strong> banco(s):
              {[...selecionados]
                .map((id) => alvos.find((a) => a.id === id)?.nome)
                .filter(Boolean)
                .join(", ")}
              {transacao
                ? " Com a opção tudo-ou-nada ativa, cada banco que falhar será revertido por completo."
                : " A opção tudo-ou-nada está DESLIGADA: cada comando é persistido individualmente."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor="confirmar-texto">
              Digite <strong>EXECUTAR</strong> para liberar
            </Label>
            <Input
              id="confirmar-texto"
              value={confirmacaoTexto}
              onChange={(e) => setConfirmacaoTexto(e.target.value)}
              placeholder="EXECUTAR"
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiálogoExecutar(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={executarDefinitivo}
              disabled={confirmacaoTexto.trim().toUpperCase() !== "EXECUTAR"}
            >
              <Play className="size-4" /> Aplicar agora
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resultado de um alvo
// ---------------------------------------------------------------------------
function ResultadoAlvo({ alvo, estado }: { alvo?: AlvoSql; estado?: EstadoAlvo }) {
  if (!estado || estado.fase === "aguardando") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> {alvo?.nome ?? "…"} na fila
      </div>
    );
  }
  if (estado.fase === "executando") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" /> {alvo?.nome ?? "…"} — executando…
      </div>
    );
  }

  const r = estado.resultado;
  const ok = r.status === "ok";
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{r.nome}</span>
        <Badge
          className={
            ok
              ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
              : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400"
          }
          variant="outline"
        >
          {ok ? (r.descartado ? "Ok (rollback)" : "Aplicado") : "Erro"}
        </Badge>
        <span className="text-xs text-muted-foreground">{(r.duracao_ms / 1000).toFixed(1)} s</span>
      </div>

      {ok && r.comandos.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {r.comandos.slice(0, 20).map((c, i) => (
            <span
              key={i}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {c.comando}
              {c.linhas != null ? ` · ${c.linhas} linha(s)` : ""}
            </span>
          ))}
        </div>
      )}

      {!ok && r.erro && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-red-500/5 p-2 font-mono text-xs text-red-700 dark:text-red-400">
          {r.erro}
        </pre>
      )}

      {ok && r.preview && (
        <details className="pt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:underline">
            Ver pré-visualização de consulta ({r.preview.linhas.length} linha(s))
          </summary>
          <div className="mt-2 max-h-56 overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  {r.preview.colunas.map((c) => (
                    <th key={c} className="px-2 py-1 text-left font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.preview.linhas.map((linha, i) => (
                  <tr key={i} className="border-t">
                    {r.preview!.colunas.map((c) => (
                      <td key={c} className="max-w-48 truncate px-2 py-1 font-mono">
                        {linha[c] === null ? "—" : String(linha[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
