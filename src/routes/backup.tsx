import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ActivitySquare,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Database,
  Download,
  History,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  agendamentosApi,
  backupsApi,
  erroMensagem,
  instanciasApi,
  restoreApi,
  sessaoBackup,
  type AgendamentoResumo,
  type BackupArquivoResumo,
  type BackupJobResumo,
  type InstanciaResumo,
  type RestoreOperacaoResumo,
  type ResultadoConexao,
} from "@/lib/backup-api";
import { getClient, type Cliente } from "@/lib/painel-db";

export const Route = createFileRoute("/backup")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Backup & Restauração — JVA Sistemas" },
      {
        name: "description",
        content: "Central de backup e restauração de instâncias Supabase da JVA Sistemas.",
      },
    ],
  }),
  component: () => (
    <PainelLayout>
      <ModuloBackup />
    </PainelLayout>
  ),
});

// ---------------------------------------------------------------------------
// Estado operacional → cor de badge
// ---------------------------------------------------------------------------
const ROTULO_STATUS_CONEXAO: Record<
  InstanciaResumo["status_conexao"],
  { rotulo: string; classe: string }
> = {
  desconhecido: {
    rotulo: "Sem teste",
    classe: "border-muted-foreground/40 bg-muted text-muted-foreground",
  },
  ok: {
    rotulo: "Conectada",
    classe: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
  },
  falha: {
    rotulo: "Falhou",
    classe: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

const ROTULO_AMBIENTE: Record<InstanciaResumo["ambiente"], string> = {
  producao: "Produção",
  homologacao: "Homologação",
  desenvolvimento: "Desenvolvimento",
};

// ---------------------------------------------------------------------------
// Módulo com gate administrativo
// ---------------------------------------------------------------------------
function ModuloBackup() {
  const [sessao, setSessao] = useState<Awaited<ReturnType<typeof sessaoBackup.atual>> | null>(null);
  const [verificando, setVerificando] = useState(true);

  const consultarSessao = useCallback(async () => {
    try {
      setSessao(await sessaoBackup.atual());
    } catch (e) {
      toast.error(erroMensagem(e));
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

  return <AdminBackup onSair={consultarSessao} />;
}

function TelaLogin({ onLogado }: { onLogado: () => void }) {
  const [senha, setSenha] = useState("");
  const [entrando, setEntrando] = useState(false);

  const entrar = async (evento: React.FormEvent) => {
    evento.preventDefault();
    setEntrando(true);
    try {
      await sessaoBackup.login(senha);
      onLogado();
    } catch (e) {
      toast.error(erroMensagem(e));
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
            Backup &amp; Restauração é um módulo exclusivo da administração. Informe a senha de
            administrador definida no servidor.
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
// Painel administrativo (abas)
// ---------------------------------------------------------------------------
function AdminBackup({ onSair }: { onSair: () => void }) {
  const [instancias, setInstancias] = useState<InstanciaResumo[]>([]);
  const [agendamentos, setAgendamentos] = useState<AgendamentoResumo[]>([]);
  const [operacoes, setOperacoes] = useState<BackupJobResumo[]>([]);
  const [arquivos, setArquivos] = useState<BackupArquivoResumo[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [carregando, setCarregando] = useState(true);

  const carregarTudo = useCallback(async () => {
    setCarregando(true);
    try {
      const [listaInst, listaAgend, listaOper, listaArq, clientesData] = await Promise.all([
        instanciasApi.listar(),
        agendamentosApi.listar().catch(() => [] as AgendamentoResumo[]),
        backupsApi.listarOperacoes().catch(() => [] as BackupJobResumo[]),
        backupsApi.listarArquivos().catch(() => [] as BackupArquivoResumo[]),
        getClient()
          .from("clientes")
          .select("id, nome_fantasia")
          .order("nome_fantasia", { ascending: true })
          .then(({ data }) => (data ?? []) as Cliente[]),
      ]);
      setInstancias(listaInst);
      setAgendamentos(listaAgend);
      setOperacoes(listaOper);
      setArquivos(listaArq);
      setClientes(clientesData);
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarTudo();
  }, [carregarTudo]);

  const nomeCliente = useCallback(
    (id: string | null) => clientes.find((c) => c.id === id)?.nome_fantasia ?? null,
    [clientes],
  );

  const abas = useMemo(
    () => [
      { valor: "dashboard", rotulo: "Dashboard", icone: ActivitySquare },
      { valor: "instancias", rotulo: "Instâncias", icone: Database },
      { valor: "agendamentos", rotulo: "Agendamentos", icone: CalendarClock },
      { valor: "historico", rotulo: "Backups", icone: History },
      { valor: "restauracao", rotulo: "Restauração", icone: Undo2 },
    ],
    [],
  );

  const nomePorId = useMemo(() => {
    const mapa = new Map(instancias.map((i) => [i.id, i.nome]));
    return (id: string) => mapa.get(id) ?? "—";
  }, [instancias]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Backup &amp; Restauração</h1>
          <p className="text-sm text-muted-foreground">
            Gerenciamento centralizado de instâncias Supabase, backups e restaurações.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={carregarTudo} disabled={carregando}>
            <RefreshCw className="size-4" /> Atualizar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await sessaoBackup.logout();
                onSair();
              } catch (e) {
                toast.error(erroMensagem(e));
              }
            }}
          >
            Sair
          </Button>
        </div>
      </div>

      <Tabs defaultValue="dashboard" className="gap-4">
        <TabsList className="flex w-full flex-wrap justify-start gap-1 overflow-x-auto">
          {abas.map(({ valor, rotulo, icone: Icone }) => (
            <TabsTrigger key={valor} value={valor}>
              <Icone className="size-4" /> {rotulo}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="dashboard">
          <Dashboard
            instancias={instancias}
            agendamentos={agendamentos}
            operacoes={operacoes}
            arquivos={arquivos}
          />
        </TabsContent>

        <TabsContent value="instancias">
          <SecaoInstancias
            instancias={instancias}
            clientes={clientes}
            nomeCliente={nomeCliente}
            recarregar={carregarTudo}
          />
        </TabsContent>

        <TabsContent value="agendamentos">
          <SecaoAgendamentos
            instancias={instancias}
            agendamentos={agendamentos}
            nomePorId={nomePorId}
            recarregar={carregarTudo}
          />
        </TabsContent>

        <TabsContent value="historico">
          <SecaoBackups
            instancias={instancias}
            operacoes={operacoes}
            arquivos={arquivos}
            recarregar={carregarTudo}
          />
        </TabsContent>

        <TabsContent value="restauracao">
          <SecaoRestauracao arquivos={arquivos} instancias={instancias} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AvisoFase({ fase, texto }: { fase: string; texto: string }) {
  return (
    <Alert>
      <CalendarClock className="size-4" />
      <AlertTitle>{fase} desta implementação</AlertTitle>
      <AlertDescription>
        {texto}
        <br />
        Esta aba fica ativa tão logo a etapa correspondente seja concluída — nenhuma tela
        demonstrativa é apresentada como funcionalidade.
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function Dashboard({
  instancias,
  agendamentos,
  operacoes,
  arquivos,
}: {
  instancias: InstanciaResumo[];
  agendamentos: AgendamentoResumo[];
  operacoes: BackupJobResumo[];
  arquivos: BackupArquivoResumo[];
}) {
  const total = instancias.length;
  const conectadas = instancias.filter((i) => i.status_conexao === "ok").length;
  const ativas = instancias.filter((i) => i.ativo).length;
  const backupsValidos = arquivos.filter((a) => a.validado);
  const ultimoBackupValido =
    backupsValidos
      .map((a) => a.criado_em)
      .sort()
      .at(-1) ?? null;
  const falhas = operacoes.filter((o) => o.status === "falha").length;
  const espacoUtilizado = arquivos.reduce((soma, a) => soma + (a.tamanho_bytes ?? 0), 0);
  const emAndamento = operacoes.filter((o) =>
    ["pendente", "executando", "validando"].includes(o.status),
  ).length;

  const proximos = agendamentos.filter((a) => a.ativo && a.proxima_execucao).slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      {emAndamento > 0 && (
        <Alert>
          <ActivitySquare className="size-4" />
          <AlertTitle>{emAndamento} operação(ões) em andamento</AlertTitle>
          <AlertDescription>
            O backup requer execução no worker (GitHub Actions) — acompanhe na aba Backups.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Instâncias cadastradas</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{total}</p>
            <p className="text-xs text-muted-foreground">{ativas} ativas</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Instâncias conectadas</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{conectadas}</p>
            <p className="text-xs text-muted-foreground">
              {total - conectadas} sem conexão / sem teste
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Último backup válido</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{formataData(ultimoBackupValido)}</p>
            <p className="text-xs text-muted-foreground">
              {backupsValidos.length} válido(s) no total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Backups com falha</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{falhas}</p>
            <p className="text-xs text-muted-foreground">
              Espaço utilizado: {formataBytes(espacoUtilizado)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Próximos agendamentos</CardTitle>
          <CardDescription>
            Execuções automáticas já programadas (fuso configurado por instância).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {proximos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum agendamento com execução futura. Cadastre instâncias e defina um agendamento.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {proximos.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-1 text-sm"
                >
                  <span className="font-medium">
                    {nomePorIdFallback(a.instance_id, instancias)}
                  </span>
                  <span className="text-muted-foreground">
                    {rotuloFrequencia(a.frequencia, a.dia_semana, a.dia_mes)} · {a.hora} · {a.fuso}
                  </span>
                  <Badge
                    variant="outline"
                    className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                  >
                    {formataData(a.proxima_execucao)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function nomePorIdFallback(id: string, lista: InstanciaResumo[]) {
  return lista.find((i) => i.id === id)?.nome ?? "—";
}

function rotuloFrequencia(
  frequencia: AgendamentoResumo["frequencia"],
  diaSemana: number | null,
  diaMes: number | null,
): string {
  if (frequencia === "diario") return "Diário";
  if (frequencia === "semanal") {
    const dias = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
    return `Semanal (${dias[diaSemana ?? 0]})`;
  }
  if (frequencia === "mensal") return `Mensal (dia ${diaMes ?? 1})`;
  return "Personalizado";
}

function formataData(valor: string | null | undefined): string {
  if (!valor) return "—";
  try {
    return new Date(valor).toLocaleString("pt-BR");
  } catch {
    return valor;
  }
}

function formataBytes(valor: number | null | undefined): string {
  if (valor == null) return "—";
  if (valor < 1024) return `${valor} B`;
  const unidades = ["KB", "MB", "GB", "TB"];
  let tamanho = valor / 1024;
  let idx = 0;
  while (tamanho >= 1024 && idx < unidades.length - 1) {
    tamanho /= 1024;
    idx++;
  }
  return `${tamanho.toFixed(1)} ${unidades[idx]}`;
}

const ROTULO_STATUS_JOB: Record<BackupJobResumo["status"], { rotulo: string; classe: string }> = {
  pendente: {
    rotulo: "Aguardando worker",
    classe: "border-muted-foreground/40 bg-muted text-muted-foreground",
  },
  executando: {
    rotulo: "Executando",
    classe: "animate-pulse border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  validando: {
    rotulo: "Validando",
    classe: "animate-pulse border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  },
  concluido: {
    rotulo: "Concluído",
    classe: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
  },
  falha: {
    rotulo: "Falhou",
    classe: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  cancelado: {
    rotulo: "Cancelado",
    classe: "border-muted-foreground/40 bg-muted text-muted-foreground",
  },
};

// ---------------------------------------------------------------------------
// Backups — execução manual, operações, histórico, download e integridade
// ---------------------------------------------------------------------------
function SecaoBackups({
  instancias,
  operacoes,
  arquivos,
  recarregar,
}: {
  instancias: InstanciaResumo[];
  operacoes: BackupJobResumo[];
  arquivos: BackupArquivoResumo[];
  recarregar: () => Promise<void>;
}) {
  const elegiveis = instancias.filter((i) => i.ativo && i.credencial_ok);
  const [instanciaSelecionada, setInstanciaSelecionada] = useState("");
  const [executando, setExecutando] = useState(false);
  const [verificandoId, setVerificandoId] = useState<string | null>(null);
  const [logAberto, setLogAberto] = useState<BackupJobResumo | null>(null);
  // Enquanto houver operação pendente/executando/validando, atualiza a cada 5s
  const haOperacaoAtiva = operacoes.some((o) =>
    ["pendente", "executando", "validando"].includes(o.status),
  );
  useEffect(() => {
    if (!haOperacaoAtiva) return;
    const timer = setInterval(recarregar, 5000);
    return () => clearInterval(timer);
  }, [haOperacaoAtiva, recarregar]);

  const iniciar = async () => {
    if (!instanciaSelecionada) return;
    setExecutando(true);
    try {
      await backupsApi.iniciar(instanciaSelecionada);
      toast.success("Backup enfileirado — o worker executa e valida automaticamente.");
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setExecutando(false);
    }
  };

  const baixar = async (arquivo: BackupArquivoResumo) => {
    try {
      const { url } = await backupsApi.urlDownload(arquivo.id);
      window.open(url, "_blank", "noopener,noreferrer");
      toast.success(`Download liberado (URL válida por 15 min): ${arquivo.nome_arquivo}`);
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  const verificar = async (arquivo: BackupArquivoResumo) => {
    setVerificandoId(arquivo.id);
    try {
      const resultado = await backupsApi.verificar(arquivo.id);
      if (resultado.ok) toast.success(resultado.detalhe);
      else toast.warning(resultado.detalhe);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setVerificandoId(null);
    }
  };

  const excluir = async (arquivo: BackupArquivoResumo) => {
    if (
      !confirm(
        `Excluir o backup "${arquivo.nome_arquivo}"?\n\nO arquivo .dump é removido do armazenamento privado e o registro sai do histórico (ação auditada).`,
      )
    )
      return;
    try {
      await backupsApi.excluir(arquivo.id);
      toast.success("Backup excluído.");
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Backup manual</CardTitle>
          <CardDescription>
            O painel enfileira a operação; o worker (GitHub Actions) executa o pg_dump, valida a
            estrutura do arquivo, calcula o SHA-256 e envia ao armazenamento privado. A conclusão só
            aparece após validação e upload bem-sucedidos.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1">
            <Select value={instanciaSelecionada} onValueChange={setInstanciaSelecionada}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione a instância de origem" />
              </SelectTrigger>
              <SelectContent>
                {elegiveis.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.nome} — {ROTULO_AMBIENTE[i.ambiente]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={iniciar}
            disabled={!instanciaSelecionada || executando || haOperacaoAtiva}
          >
            <History className="size-4" /> {executando ? "Enfileirando…" : "Executar Backup Agora"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Operações</CardTitle>
          <CardDescription>
            Últimas operações (atualização automática a cada 5s enquanto houver execução em
            andamento).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {operacoes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma operação registrada ainda.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {operacoes.slice(0, 8).map((op) => {
                const status = ROTULO_STATUS_JOB[op.status];
                return (
                  <li
                    key={op.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {["executando", "validando"].includes(op.status) && (
                        <Loader2 className="size-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                      )}
                      <Badge className={status.classe}>{status.rotulo}</Badge>
                      <span className="font-medium">{op.instance_nome}</span>
                      <span className="text-xs text-muted-foreground">
                        {op.tipo === "automatico" ? "automático" : "manual"} ·{" "}
                        {formataData(op.criado_em)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {op.log_execucao && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setLogAberto(op)}
                        >
                          <History className="size-3.5" /> Log
                        </Button>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {op.status === "concluido"
                          ? `concluído em ${op.finalizado_em ? formataData(op.finalizado_em) : "—"}${
                              op.versao_pg_dump ? ` · ${op.versao_pg_dump}` : ""
                            }`
                          : op.erro
                            ? op.erro
                            : `tentativa ${op.tentativas}/${op.max_tentativas}`}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={logAberto !== null} onOpenChange={(aberto) => !aberto && setLogAberto(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Log da operação — {logAberto?.instance_nome ?? "—"}
            </DialogTitle>
            <DialogDescription>
              Passo a passo executado pelo worker (GitHub Actions → pg_dump → validação → bucket).
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {logAberto?.log_execucao ?? ""}
          </pre>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Tamanho</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Validação</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {arquivos.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  Nenhum backup armazenado ainda.
                </TableCell>
              </TableRow>
            )}
            {arquivos.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="max-w-56 truncate font-mono text-xs">
                  {a.nome_arquivo}
                </TableCell>
                <TableCell>{a.instance_nome}</TableCell>
                <TableCell>{formataData(a.criado_em)}</TableCell>
                <TableCell>{formataBytes(a.tamanho_bytes)}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-muted-foreground/40 bg-muted text-muted-foreground"
                  >
                    {a.tipo}
                  </Badge>
                </TableCell>
                <TableCell>
                  {a.validado ? (
                    <Badge className="border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400">
                      íntegro
                    </Badge>
                  ) : (
                    <Badge variant="secondary">não validado</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => baixar(a)}
                      title="Baixar (URL temporária)"
                    >
                      <Download className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={verificandoId === a.id}
                      onClick={() => verificar(a)}
                      title="Verificar integridade"
                    >
                      <CheckCircle2 className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => excluir(a)}
                      title="Excluir com confirmação"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restauração — wizard seguro (FASE 7)
// ---------------------------------------------------------------------------
const ROTULO_RESTORE_STATUS: Record<
  RestoreOperacaoResumo["status"],
  { rotulo: string; classe: string }
> = {
  pendente_precheck: {
    rotulo: "Pré-verificando",
    classe: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  falha_precheck: {
    rotulo: "Falhou no precheck",
    classe: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  aguardando_confirmacao: {
    rotulo: "Aguardando confirmação",
    classe: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  pendente: {
    rotulo: "Autorizado — na fila",
    classe: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  },
  executando: {
    rotulo: "Executando",
    classe: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  validando: {
    rotulo: "Validando",
    classe: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  },
  concluido: {
    rotulo: "Concluído",
    classe: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
  },
  falha: {
    rotulo: "Falhou",
    classe: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  cancelado: {
    rotulo: "Cancelado",
    classe: "border-muted-foreground/40 bg-muted text-muted-foreground",
  },
};

function SecaoRestauracao({
  arquivos,
  instancias,
}: {
  arquivos: BackupArquivoResumo[];
  instancias: InstanciaResumo[];
}) {
  const validos = arquivos.filter((a) => a.validado);
  const destinos = instancias.filter((i) => i.ativo && i.credencial_ok);

  const [arquivoId, setArquivoId] = useState("");
  const [destinoId, setDestinoId] = useState("");
  const [modo, setModo] = useState<"aplicacao" | "migracao">("aplicacao");
  const [schemasEscolhidos, setSchemasEscolhidos] = useState<string[]>([]);
  const [operacoes, setOperacoes] = useState<RestoreOperacaoResumo[]>([]);
  const [digitado, setDigitado] = useState("");
  const [dialogoId, setDialogoId] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const instPorId = useMemo(() => new Map(instancias.map((i) => [i.id, i])), [instancias]);

  const carregar = useCallback(async () => {
    try {
      setOperacoes(await restoreApi.listar());
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const ativa = operacoes.find((o) =>
    ["pendente_precheck", "aguardando_confirmacao", "pendente", "executando", "validando"].includes(
      o.status,
    ),
  );

  // Polling quando houver operação em andamento (precheck/execução)
  useEffect(() => {
    if (!ativa) return;
    const timer = setInterval(carregar, 5000);
    return () => clearInterval(timer);
  }, [ativa, carregar]);

  const arquivo = validos.find((a) => a.id === arquivoId);
  const destino = destinos.find((i) => i.id === destinoId);

  const preverificar = async () => {
    if (!arquivo || !destino) return;
    setOcupado(true);
    try {
      await restoreApi.precheck({
        backup_file_id: arquivo.id,
        destino_instance_id: destino.id,
        modo,
        schemas_alvo: modo === "aplicacao" ? schemasEscolhidos : [],
      });
      toast.success("Pré-verificação enfileirada — o worker analisa o dump e o destino.");
      setSchemasEscolhidos([]);
      await carregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setOcupado(false);
    }
  };

  const alternarSchema = (schema: string) => {
    setSchemasEscolhidos((atual) =>
      atual.includes(schema) ? atual.filter((s) => s !== schema) : [...atual, schema],
    );
  };

  const salvarSchemas = async (jobId: string) => {
    setOcupado(true);
    try {
      await restoreApi.atualizarSchemas(jobId, schemasEscolhidos);
      toast.success("Schemas definidos para a restauração.");
      await carregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setOcupado(false);
    }
  };

  const abrirDialogo = (jobId: string) => {
    setDigitado("");
    setDialogoId(jobId);
  };

  const confirmar = async () => {
    if (!dialogoId || !digitado.trim()) return;
    setOcupado(true);
    try {
      await restoreApi.confirmar(dialogoId, digitado);
      toast.success("Restauração autorizada — backup de segurança será criado antes da execução.");
      setDialogoId(null);
      await carregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async (jobId: string) => {
    if (!confirm("Cancelar esta restauração?")) return;
    try {
      await restoreApi.cancelar(jobId);
      toast.success("Restauração cancelada.");
      await carregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  const aguardando = operacoes.find((o) => o.status === "aguardando_confirmacao");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Nova restauração</CardTitle>
          <CardDescription>
            Fluxo seguro em duas etapas: <strong>pré-verificação</strong> (relatório de schemas,
            conflitos e avisos — nada é alterado) e <strong>execução</strong>, liberada apenas após
            digitar o nome da instância de destino. Um backup de segurança do destino é criado
            automaticamente antes de qualquer restauração.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>Backup de origem (.dump validado)</Label>
              <Select value={arquivoId} onValueChange={setArquivoId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o arquivo de backup" />
                </SelectTrigger>
                <SelectContent>
                  {validos.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.instance_nome} — {a.nome_arquivo.slice(-24)} ({formataData(a.criado_em)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Instância de destino</Label>
              <Select value={destinoId} onValueChange={setDestinoId}>
                <SelectTrigger>
                  <SelectValue placeholder="Onde os dados serão restaurados" />
                </SelectTrigger>
                <SelectContent>
                  {destinos.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.nome} — {ROTULO_AMBIENTE[i.ambiente]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Modo de restauração</Label>
            <Select value={modo} onValueChange={(v) => setModo(v as "aplicacao" | "migracao")}>
              <SelectTrigger className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="aplicacao">
                  Modo A — Aplicação: restaura apenas os schemas escolhidos
                </SelectItem>
                <SelectItem value="migracao">
                  Modo B — Migração: restaura tudo fora dos schemas gerenciados (auth/storage
                  intactos)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="secondary"
            onClick={preverificar}
            disabled={!arquivo || !destino || ocupado || Boolean(ativa)}
          >
            <PlugZap className="size-4" /> {ocupado ? "Enviando…" : "Pré-verificar"}
          </Button>
        </CardContent>
      </Card>

      {aguardando?.precheck && (
        <Card className="border-amber-500/50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" /> Relatório de pré-verificação
            </CardTitle>
            <CardDescription>
              {aguardando.origem_nome} → <strong>{aguardando.destino_nome}</strong> ·{" "}
              {aguardando.precheck.arquivo.nome_arquivo}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Restauração destrutiva</AlertTitle>
              <AlertDescription>
                As tabelas compatíveis serão apagadas e recriadas (— <code>--clean</code>) nos
                schemas selecionados. Confirme digitando o nome completo da instância de destino.
              </AlertDescription>
            </Alert>

            <div>
              <Label className="mb-2 block">Schemas do dump</Label>
              <div className="flex flex-wrap gap-2">
                {aguardando.precheck.dump.schemas.map((s) => (
                  <Badge
                    key={s.nome}
                    variant="outline"
                    className={
                      s.gerenciado
                        ? "border-muted-foreground/40 bg-muted text-muted-foreground"
                        : "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                    }
                  >
                    {s.nome}: {s.tabelas} tabelas · {s.dados} dados
                    {s.gerenciado ? " (gerenciado, ignorado)" : ""}
                  </Badge>
                ))}
              </div>
            </div>

            {aguardando.modo === "aplicacao" && (
              <div>
                <Label className="mb-2 block">
                  Selecione os schemas a restaurar (só não-gerenciados)
                </Label>
                <div className="flex flex-col gap-2">
                  {aguardando.precheck.dump.schemas
                    .filter((s) => !s.gerenciado)
                    .map((s) => (
                      <label key={s.nome} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={schemasEscolhidos.includes(s.nome)}
                          onChange={() => alternarSchema(s.nome)}
                        />
                        <span className="font-medium">{s.nome}</span>
                        <span className="text-muted-foreground">
                          — {s.tabelas} tabelas no dump ·{" "}
                          {aguardando.precheck?.destino.schemas[s.nome] ?? 0} tabelas no destino
                          hoje
                        </span>
                      </label>
                    ))}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={schemasEscolhidos.length === 0 || ocupado}
                  onClick={() => salvarSchemas(aguardando.id)}
                >
                  Definir schemas selecionados
                </Button>
              </div>
            )}

            {aguardando.precheck.conflitos.length > 0 && (
              <div>
                <Label className="mb-1 block">Conflitos (tabelas já existentes no destino)</Label>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {aguardando.precheck.conflitos.map((c) => (
                    <li key={c.schema}>
                      <span className="font-medium text-foreground">{c.schema}</span>:{" "}
                      {c.tabelas_no_destino} tabelas no destino ·{" "}
                      {c.tabelas_substituidas.length > 0
                        ? `${c.tabelas_substituidas.length} serão substituídas (ex.: ${c.tabelas_substituidas.slice(0, 3).join(", ")})`
                        : "nenhuma colisão direta de nomes"}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {aguardando.precheck.avisos.length > 0 && (
              <div>
                <Label className="mb-1 block">Avisos</Label>
                <ul className="list-disc flex flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  {aguardando.precheck.avisos.map((aviso, idx) => (
                    <li key={idx}>{aviso}</li>
                  ))}
                </ul>
              </div>
            )}

            <Button className="self-start" onClick={() => abrirDialogo(aguardando.id)}>
              <Undo2 className="size-4" /> Confirmar restauração
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={Boolean(dialogoId)}
        onOpenChange={(aberto) => {
          if (!aberto) setDialogoId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar restauração destrutiva</DialogTitle>
            <DialogDescription>
              Digite o nome da instância de destino (
              <strong>{dialogoId ? aguardando?.destino_nome : ""}</strong>) para liberar a execução.
              O worker criará o backup de segurança do destino antes de restaurar.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={digitado}
            onChange={(e) => setDigitado(e.target.value)}
            placeholder="Nome exato da instância de destino"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogoId(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={ocupado || digitado.trim() !== (aguardando?.destino_nome ?? "")}
              onClick={confirmar}
            >
              {ocupado ? "Confirmando…" : "Liberar restauração"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Origem → Destino</TableHead>
              <TableHead>Modo</TableHead>
              <TableHead>Backup</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {operacoes.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Nenhuma restauração registrada ainda.
                </TableCell>
              </TableRow>
            )}
            {operacoes.map((r) => {
              const status = ROTULO_RESTORE_STATUS[r.status];
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="font-medium">{r.origem_nome}</span>
                    <span className="mx-1 text-muted-foreground">→</span>
                    <span className="font-medium">{r.destino_nome}</span>
                    {r.duracao_seg != null && (
                      <span className="ml-2 text-xs text-muted-foreground">({r.duracao_seg}s)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.modo === "aplicacao"
                      ? `A · ${r.schemas_alvo.length > 0 ? r.schemas_alvo.join(", ") : "sem schemas"}`
                      : "B · migração"}
                  </TableCell>
                  <TableCell className="max-w-52 truncate text-xs">{r.arquivo_nome}</TableCell>
                  <TableCell>
                    <Badge className={status.classe}>{status.rotulo}</Badge>
                    {r.erro && (
                      <p className="mt-1 max-w-72 truncate text-xs text-destructive" title={r.erro}>
                        {r.erro}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {r.status === "aguardando_confirmacao" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => abrirDialogo(r.id)}
                          title="Confirmar"
                        >
                          <ShieldCheck className="size-4" />
                        </Button>
                      )}
                      {["pendente_precheck", "aguardando_confirmacao", "pendente"].includes(
                        r.status,
                      ) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => cancelar(r.id)}
                          title="Cancelar"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Schemas gerenciados do Supabase (
        {["auth", "storage", "realtime", "graphql_public", "supabase_functions"].join(", ")}, etc.)
        jamais são restaurados por cima — guardam usuários, sessões, buckets e metadados da
        plataforma.
        {instPorId.size > 0 &&
          " A precheck e a execução rodam no worker (GitHub Actions), nunca no navegador."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instâncias
// ---------------------------------------------------------------------------
type FormInstancia = {
  id?: string;
  nome: string;
  cliente_id: string;
  project_ref: string;
  storage_prefix: string;
  supabase_url: string;
  db_host: string;
  db_port: string;
  db_user: string;
  db_name: string;
  ambiente: InstanciaResumo["ambiente"];
  credencial: string;
};

const FORM_VAZIO: FormInstancia = {
  nome: "",
  cliente_id: "nenhum",
  project_ref: "",
  storage_prefix: "",
  supabase_url: "",
  db_host: "",
  db_port: "5432",
  db_user: "postgres",
  db_name: "postgres",
  ambiente: "producao",
  credencial: "",
};

function SecaoInstancias({
  instancias,
  clientes,
  nomeCliente,
  recarregar,
}: {
  instancias: InstanciaResumo[];
  clientes: Cliente[];
  nomeCliente: (id: string | null) => string | null;
  recarregar: () => Promise<void>;
}) {
  const [dialogoAberto, setDialogoAberto] = useState(false);
  const [form, setForm] = useState<FormInstancia>(FORM_VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [testandoId, setTestandoId] = useState<string | null>(null);

  const abrirNovo = () => {
    setForm(FORM_VAZIO);
    setDialogoAberto(true);
  };

  const abrirEdicao = (inst: InstanciaResumo) => {
    setForm({
      id: inst.id,
      nome: inst.nome,
      cliente_id: inst.cliente_id ?? "nenhum",
      project_ref: inst.project_ref,
      storage_prefix: inst.storage_prefix ?? "",
      supabase_url: inst.supabase_url ?? "",
      db_host: inst.db_host,
      db_port: String(inst.db_port),
      db_user: inst.db_user,
      db_name: inst.db_name,
      ambiente: inst.ambiente,
      credencial: "", // nunca volta ao form; em branco = mantém a atual
    });
    setDialogoAberto(true);
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      const dados = {
        nome: form.nome.trim(),
        cliente_id: form.cliente_id === "nenhum" ? null : form.cliente_id,
        project_ref: form.project_ref.trim().toLowerCase(),
        supabase_url:
          form.supabase_url.trim() ||
          (form.project_ref.trim()
            ? `https://${form.project_ref.trim().toLowerCase()}.supabase.co`
            : ""),
        db_host:
          form.db_host.trim() ||
          (form.project_ref.trim()
            ? `db.${form.project_ref.trim().toLowerCase()}.supabase.com`
            : ""),
        db_port: Number(form.db_port) || 5432,
        db_user: form.db_user.trim() || "postgres",
        db_name: form.db_name.trim() || "postgres",
        ambiente: form.ambiente,
        credencial: form.credencial || undefined,
        storage_prefix: form.storage_prefix.trim().toLowerCase(),
      };
      if (form.id) {
        await instanciasApi.editar({ id: form.id, ...dados });
        toast.success("Instância atualizada.");
      } else {
        await instanciasApi.criar(dados);
        toast.success("Instância cadastrada.");
      }
      setDialogoAberto(false);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setSalvando(false);
    }
  };

  const testar = async (id: string) => {
    setTestandoId(id);
    try {
      const resultado = (await instanciasApi.testar(id)) as ResultadoConexao;
      if (resultado.ok) toast.success(`Conexão OK — ${resultado.detalhe}`);
      else toast.error(`Conexão falhou — ${resultado.detalhe}`);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setTestandoId(null);
    }
  };

  const alternarAtivo = async (inst: InstanciaResumo) => {
    try {
      await instanciasApi.ativar(inst.id, !inst.ativo);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  const excluir = async (inst: InstanciaResumo) => {
    if (
      !confirm(
        `Excluir a instância "${inst.nome}"?\n\nHistórico e agendamentos vinculados são removidos juntos (backups armazenados no bucket privado permanecem).`,
      )
    )
      return;
    try {
      await instanciasApi.excluir(inst.id);
      toast.success("Instância excluída.");
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cada instância representa um projeto Supabase candidato a backup. Credenciais são
          armazenadas criptografadas no servidor e nunca retornam ao navegador.
        </p>
        <Button size="sm" onClick={abrirNovo}>
          <Plus className="size-4" /> Nova instância
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Projeto</TableHead>
              <TableHead>Ambiente</TableHead>
              <TableHead>Conexão</TableHead>
              <TableHead>Credencial</TableHead>
              <TableHead>Último backup</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instancias.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  Nenhuma instância cadastrada.
                </TableCell>
              </TableRow>
            )}
            {instancias.map((inst) => {
              const status = ROTULO_STATUS_CONEXAO[inst.status_conexao];
              return (
                <TableRow key={inst.id} className={inst.ativo ? "" : "opacity-60"}>
                  <TableCell className="font-medium">
                    {inst.nome}
                    {!inst.ativo && (
                      <Badge variant="secondary" className="ml-2">
                        desativada
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{nomeCliente(inst.cliente_id) ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {inst.project_ref}
                    {inst.storage_prefix ? (
                      <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                        ➜ <span>{inst.storage_prefix}/</span>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        inst.ambiente === "producao"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          : "border-muted-foreground/40"
                      }
                    >
                      {ROTULO_AMBIENTE[inst.ambiente]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={status.classe}>{status.rotulo}</Badge>
                  </TableCell>
                  <TableCell>
                    {inst.credencial_ok ? (
                      <Badge className="border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400">
                        criptografada
                      </Badge>
                    ) : (
                      <Badge variant="destructive">ausente</Badge>
                    )}
                  </TableCell>
                  <TableCell>{formataData(inst.ultimo_backup_em)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!inst.credencial_ok || testandoId === inst.id}
                        onClick={() => testar(inst.id)}
                        title="Testar conexão (executado no servidor)"
                      >
                        {testandoId === inst.id ? (
                          <RefreshCw className="size-4 animate-spin" />
                        ) : (
                          <PlugZap className="size-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => abrirEdicao(inst)}
                        title="Editar"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => alternarAtivo(inst)}
                        title={inst.ativo ? "Desativar" : "Ativar"}
                      >
                        <Power className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => excluir(inst)}
                        title="Excluir"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogoAberto} onOpenChange={setDialogoAberto}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar instância" : "Nova instância Supabase"}</DialogTitle>
            <DialogDescription>
              A senha do banco é utilizada apenas pelo worker (enviada sempre pela variável de
              ambiente
              <code className="mx-1">PGPASSWORD</code>, nunca por argumentos de linha de comando).
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="inst-nome">Nome da instância</Label>
              <Input
                id="inst-nome"
                value={form.nome}
                onChange={(e) => setForm({ ...form, nome: e.target.value })}
                placeholder="Ex.: MeuPedix Produção"
              />
            </div>

            <div className="grid gap-1.5">
              <Label>Cliente associado (opcional)</Label>
              <Select
                value={form.cliente_id}
                onValueChange={(v) => setForm({ ...form, cliente_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sem cliente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nenhum">Sem cliente</SelectItem>
                  {clientes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.nome_fantasia}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="inst-ref">Identificador do projeto (ref)</Label>
              <Input
                id="inst-ref"
                value={form.project_ref}
                onChange={(e) => setForm({ ...form, project_ref: e.target.value })}
                placeholder="20 caracteres — ex.: hepvdpktubhcklerdvqb"
                className="font-mono"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="inst-destino">Destino do backup (pasta no bucket)</Label>
              <Input
                id="inst-destino"
                value={form.storage_prefix}
                onChange={(e) => setForm({ ...form, storage_prefix: e.target.value })}
                placeholder="Vazio = usa o próprio ref — ex.: clientes/agrosilus"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                O .dump vai para o bucket privado <code className="font-mono">backups</code> do
                banco central, dentro dessa pasta. Deixe em branco para usar o ref do projeto.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="inst-url">URL pública do Supabase (opcional)</Label>
                <Input
                  id="inst-url"
                  value={form.supabase_url}
                  onChange={(e) => setForm({ ...form, supabase_url: e.target.value })}
                  placeholder="https://ref.supabase.co"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inst-host">Host PostgreSQL</Label>
                <Input
                  id="inst-host"
                  value={form.db_host}
                  onChange={(e) => setForm({ ...form, db_host: e.target.value })}
                  placeholder="db.ref.supabase.com"
                  className="font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="inst-porta">Porta</Label>
                  <Input
                    id="inst-porta"
                    type="number"
                    value={form.db_port}
                    onChange={(e) => setForm({ ...form, db_port: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="inst-banco">Banco</Label>
                  <Input
                    id="inst-banco"
                    value={form.db_name}
                    onChange={(e) => setForm({ ...form, db_name: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inst-user">Usuário PostgreSQL</Label>
                <Input
                  id="inst-user"
                  value={form.db_user}
                  onChange={(e) => setForm({ ...form, db_user: e.target.value })}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Ambiente</Label>
              <Select
                value={form.ambiente}
                onValueChange={(v) =>
                  setForm({ ...form, ambiente: v as FormInstancia["ambiente"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="producao">Produção</SelectItem>
                  <SelectItem value="homologacao">Homologação</SelectItem>
                  <SelectItem value="desenvolvimento">Desenvolvimento</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="inst-senha">
                Senha do banco {form.id ? "(deixe em branco para manter a atual)" : "postgres"}
              </Label>
              <Input
                id="inst-senha"
                type="password"
                value={form.credencial}
                onChange={(e) => setForm({ ...form, credencial: e.target.value })}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                Armazenada com AES-256-GCM; o servidor confirma a existência sem jamais retorná-la.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogoAberto(false)} disabled={salvando}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agendamentos
// ---------------------------------------------------------------------------
function SecaoAgendamentos({
  instancias,
  agendamentos,
  nomePorId,
  recarregar,
}: {
  instancias: InstanciaResumo[];
  agendamentos: AgendamentoResumo[];
  nomePorId: (id: string) => string;
  recarregar: () => Promise<void>;
}) {
  const [dialogoAberto, setDialogoAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState({
    instance_id: "",
    frequencia: "diario" as AgendamentoResumo["frequencia"],
    dia_semana: 0,
    dia_mes: 1,
    hora: "03:00",
    fuso: "America/Sao_Paulo",
    retencao_dias: 30,
  });

  const salvar = async () => {
    setSalvando(true);
    try {
      await agendamentosApi.criar({
        instance_id: form.instance_id,
        frequencia: form.frequencia,
        dia_semana: form.frequencia === "semanal" ? form.dia_semana : null,
        dia_mes: form.frequencia === "mensal" ? form.dia_mes : null,
        hora: form.hora,
        fuso: form.fuso,
        retencao_dias: form.retencao_dias,
      });
      toast.success("Agendamento salvo.");
      setDialogoAberto(false);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    } finally {
      setSalvando(false);
    }
  };

  const alternarAtivo = async (agend: AgendamentoResumo) => {
    try {
      await agendamentosApi.ativar(agend.id, !agend.ativo);
      await recarregar();
    } catch (e) {
      toast.error(erroMensagem(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Executados pelo worker (GitHub Actions), independentes do navegador. Retenção inicia em 30
          dias e nunca apaga o último backup válido da instância.
        </p>
        <Button size="sm" onClick={() => setDialogoAberto(true)} disabled={instancias.length === 0}>
          <Plus className="size-4" /> Novo agendamento
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instância</TableHead>
              <TableHead>Rotina</TableHead>
              <TableHead>Horário (fuso)</TableHead>
              <TableHead>Retenção</TableHead>
              <TableHead>Próxima execução</TableHead>
              <TableHead>Falhas seguidas</TableHead>
              <TableHead>Total backups</TableHead>
              <TableHead className="text-right">Ativo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agendamentos.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  Nenhum agendamento — cadastre instâncias primeiro.
                </TableCell>
              </TableRow>
            )}
            {agendamentos.map((agend) => (
              <TableRow key={agend.id} className={agend.ativo ? "" : "opacity-60"}>
                <TableCell className="font-medium">{nomePorId(agend.instance_id)}</TableCell>
                <TableCell>
                  {rotuloFrequencia(agend.frequencia, agend.dia_semana, agend.dia_mes)}
                </TableCell>
                <TableCell>
                  {agend.hora} · {agend.fuso}
                </TableCell>
                <TableCell>{agend.retencao_dias} dias</TableCell>
                <TableCell>{formataData(agend.proxima_execucao)}</TableCell>
                <TableCell>
                  {agend.falhas_consecutivas > 0 ? (
                    <Badge variant="destructive">{agend.falhas_consecutivas}</Badge>
                  ) : (
                    "0"
                  )}
                </TableCell>
                <TableCell>{agend.total_backups}</TableCell>
                <TableCell className="text-right">
                  <Switch checked={agend.ativo} onCheckedChange={() => alternarAtivo(agend)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogoAberto} onOpenChange={setDialogoAberto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Novo agendamento automático</DialogTitle>
            <DialogDescription>
              Executado pelo worker no servidor. A execução é disparada pela fila persistente e não
              depende do navegador estar aberto.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Instância</Label>
              <Select
                value={form.instance_id}
                onValueChange={(v) => setForm({ ...form, instance_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Escolha a instância" />
                </SelectTrigger>
                <SelectContent>
                  {instancias
                    .filter((i) => i.ativo)
                    .map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.nome}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Frequência</Label>
                <Select
                  value={form.frequencia}
                  onValueChange={(v) =>
                    setForm({ ...form, frequencia: v as AgendamentoResumo["frequencia"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="diario">Diário</SelectItem>
                    <SelectItem value="semanal">Semanal</SelectItem>
                    <SelectItem value="mensal">Mensal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ag-hora">Horário</Label>
                <Input
                  id="ag-hora"
                  type="time"
                  value={form.hora}
                  onChange={(e) => setForm({ ...form, hora: e.target.value })}
                />
              </div>
            </div>
            {form.frequencia === "semanal" && (
              <div className="grid gap-1.5">
                <Label>Dia da semana</Label>
                <Select
                  value={String(form.dia_semana)}
                  onValueChange={(v) => setForm({ ...form, dia_semana: Number(v) })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      ["0", "Domingo"],
                      ["1", "Segunda"],
                      ["2", "Terça"],
                      ["3", "Quarta"],
                      ["4", "Quinta"],
                      ["5", "Sexta"],
                      ["6", "Sábado"],
                    ].map(([valor, rotulo]) => (
                      <SelectItem key={valor} value={valor}>
                        {rotulo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {form.frequencia === "mensal" && (
              <div className="grid gap-1.5">
                <Label htmlFor="ag-diames">Dia do mês (1–28)</Label>
                <Input
                  id="ag-diames"
                  type="number"
                  min={1}
                  max={28}
                  value={form.dia_mes}
                  onChange={(e) => setForm({ ...form, dia_mes: Number(e.target.value) || 1 })}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ag-retencao">Retenção (dias)</Label>
                <Input
                  id="ag-retencao"
                  type="number"
                  min={1}
                  max={365}
                  value={form.retencao_dias}
                  onChange={(e) =>
                    setForm({ ...form, retencao_dias: Number(e.target.value) || 30 })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ag-fuso">Fuso horário</Label>
                <Input
                  id="ag-fuso"
                  value={form.fuso}
                  onChange={(e) => setForm({ ...form, fuso: e.target.value })}
                  placeholder="America/Sao_Paulo"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogoAberto(false)} disabled={salvando}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando || !form.instance_id}>
              {salvando ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
