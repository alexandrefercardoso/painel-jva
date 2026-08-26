import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, CircleDot, Lock, Zap } from "lucide-react";
import { PainelLayout } from "@/components/PainelLayout";
import { getClient, isConfigured, MSG_SEM_CONFIG, type Cliente } from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/modulos")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Módulos Contratados — JVA Sistemas" },
      { name: "description", content: "Gerenciar módulos Silun contratados por cliente." },
      { property: "og:title", content: "Módulos Contratados — JVA Sistemas" },
      { property: "og:description", content: "Gerenciar módulos Silun contratados por cliente." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <PainelLayout>
      <AdminModulos />
    </PainelLayout>
  ),
});

type ModuloDef = {
  slug: string;
  nome: string;
  obrigatorio?: boolean;
  novo?: boolean;
  futuro?: boolean;
};

const MODULOS_DISPONIVEIS: ModuloDef[] = [
  { slug: "nucleo", nome: "Núcleo", obrigatorio: true },
  { slug: "pdv", nome: "PDV" },
  { slug: "cereais", nome: "Cereais" },
  { slug: "rural", nome: "Rural" },
  { slug: "defensivo", nome: "Defensivo" },
  { slug: "transportadora", nome: "Transportadora" },
  { slug: "contabilidade", nome: "Contabilidade", novo: true },
  { slug: "erp", nome: "ERP", futuro: true },
];

const LARANJA = "oklch(0.65 0.25 35)";

function AdminModulos() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const [clienteSelecionado, setClienteSelecionado] = useState<Cliente | null>(null);
  const [modulosEdicao, setModulosEdicao] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!isConfigured()) {
      setErro(MSG_SEM_CONFIG);
      setCarregando(false);
      return;
    }
    getClient()
      .from("clientes")
      .select("*")
      .order("nome_fantasia", { ascending: true })
      .then(({ data, error }) => {
        if (error) setErro(error.message);
        else setClientes((data ?? []) as Cliente[]);
        setCarregando(false);
      });
  }, []);

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return clientes;
    return clientes.filter((c) => (c.nome_fantasia ?? "").toLowerCase().includes(termo));
  }, [clientes, busca]);

  const abrirModal = (cliente: Cliente) => {
    const atuais = Array.isArray(cliente.modulos_contratados) ? cliente.modulos_contratados : [];
    setModulosEdicao(atuais.map((s) => s.toLowerCase()));
    setClienteSelecionado(cliente);
  };

  const toggleModulo = (slug: string, obrigatorio?: boolean, futuro?: boolean) => {
    if (obrigatorio || futuro) return;
    setModulosEdicao((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  };

  const salvarModulos = async () => {
    if (!clienteSelecionado) return;
    setSalvando(true);

    const final = [...new Set(["nucleo", ...modulosEdicao])];

    const { error } = await getClient()
      .from("clientes")
      .update({ modulos_contratados: final })
      .eq("id", clienteSelecionado.id);

    if (error) {
      toast.error("Erro ao salvar módulos", { description: error.message });
    } else {
      setClientes((prev) =>
        prev.map((c) =>
          c.id === clienteSelecionado.id ? { ...c, modulos_contratados: final } : c,
        ),
      );
      toast.success("Módulos atualizados", {
        description: `${clienteSelecionado.nome_fantasia}: ${final.length} módulo(s) ativo(s).`,
      });
      setClienteSelecionado(null);
    }
    setSalvando(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Módulos Contratados</h1>
        <Badge variant="secondary" className="font-normal">
          {clientes.length} cliente(s)
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">
        Gerencie os módulos Silun habilitados para cada cliente.
      </p>

      <Input
        placeholder="Buscar por empresa..."
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        className="max-w-sm bg-background"
      />

      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {carregando && <p className="text-sm text-muted-foreground">Carregando...</p>}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Empresa</th>
              <th className="px-4 py-2 font-medium">E-mail</th>
              <th className="px-4 py-2 font-medium">Módulos</th>
              <th className="px-4 py-2 font-medium text-right">Ação</th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((cliente) => {
              const mods = Array.isArray(cliente.modulos_contratados)
                ? cliente.modulos_contratados
                : [];
              const ativos = mods.filter((m) => m.toLowerCase() !== "nucleo");
              return (
                <tr
                  key={cliente.id}
                  className="border-b last:border-0 bg-muted/10 hover:bg-muted/25 transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to="/clientes/$id"
                      params={{ id: String(cliente.id) }}
                      className="font-medium text-foreground hover:underline"
                    >
                      {cliente.nome_fantasia ?? "(sem nome)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {cliente.email_contato ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {MODULOS_DISPONIVEIS.filter(
                        (m) => (m.obrigatorio || ativos.includes(m.slug)) && !m.futuro,
                      ).map((m) => (
                        <span
                          key={m.slug}
                          className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
                        >
                          <Check className="h-3 w-3" />
                          {m.nome}
                        </span>
                      ))}
                      {ativos.length === 0 && (
                        <span className="text-xs text-muted-foreground">Apenas Núcleo</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => abrirModal(cliente)}
                      className="cursor-pointer"
                    >
                      Configurar módulos
                    </Button>
                  </td>
                </tr>
              );
            })}
            {!carregando && filtrados.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Nenhum cliente encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={!!clienteSelecionado}
        onOpenChange={(open) => !open && setClienteSelecionado(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleDot className="h-5 w-5" style={{ color: LARANJA }} />
              Módulos — {clienteSelecionado?.nome_fantasia}
            </DialogTitle>
            <DialogDescription>
              Selecione os módulos que este cliente terá acesso.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1 py-2">
            {MODULOS_DISPONIVEIS.map((m) => {
              const isNucleo = !!m.obrigatorio;
              const isFuturo = !!m.futuro;
              const isNovo = !!m.novo;
              const checked = isNucleo || modulosEdicao.includes(m.slug);
              const disabled = isNucleo || isFuturo;

              return (
                <label
                  key={m.slug}
                  className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                    disabled && !isNucleo
                      ? "cursor-not-allowed opacity-40"
                      : isNucleo
                        ? "cursor-default bg-muted/30"
                        : "cursor-pointer hover:bg-muted/30"
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={() => toggleModulo(m.slug, isNucleo, isFuturo)}
                    className={
                      isNucleo ? "border-emerald-500 data-[state=checked]:bg-emerald-600" : ""
                    }
                  />
                  <span className="flex-1 font-medium">{m.nome}</span>
                  {isNucleo && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <Lock className="h-3 w-3" />
                      Obrigatório
                    </span>
                  )}
                  {isNovo && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      style={{
                        backgroundColor: `color-mix(in oklch, ${LARANJA} 15%, transparent)`,
                        color: LARANJA,
                      }}
                    >
                      Novo
                    </span>
                  )}
                  {isFuturo && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Zap className="h-3 w-3" />
                      Futuro
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setClienteSelecionado(null)}
              className="cursor-pointer"
            >
              Cancelar
            </Button>
            <Button
              onClick={salvarModulos}
              disabled={salvando}
              className="cursor-pointer text-white"
              style={{ backgroundColor: LARANJA }}
            >
              {salvando ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
