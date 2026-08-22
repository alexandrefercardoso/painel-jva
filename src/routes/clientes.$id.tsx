import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PainelLayout } from "@/components/PainelLayout";
import {
  getClient,
  type Cliente,
  type Dominio,
  type Modulo,
  type ModoTipo,
  type ProdutoTipo,
  OPCOES_MODO,
} from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/clientes/$id")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Editar cliente — JVA Sistemas" },
      { name: "description", content: "Editar dados do cliente, mensalidade, status de pagamento e domínios vinculados." },
      { property: "og:title", content: "Editar cliente — JVA Sistemas" },
      { property: "og:description", content: "Editar dados do cliente, mensalidade, status de pagamento e domínios vinculados." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <PainelLayout>
      <EditarCliente />
    </PainelLayout>
  ),
});

const vazio: Partial<Cliente> = {
  produto: "MeuPedix",
  nome_fantasia: "",
  contato: "",
  telefone: "",
  email_contato: "",
  valor_mensal: null,
  dia_vencimento: null,
  status_pagamento: "em_dia",
  observacoes: "",
  ativo: true,
  empresa_id: "",
  email_login_supabase: "",
  supabase_url: "",
  supabase_anon_key: "",
  modulos_contratados: [],
  modo: "compartilhado",
};

const SLUGS_MODULOS_PADRAO = [
  "nucleo",
  "pdv",
  "erp",
  "fiscal",
  "cereais",
  "rural",
  "transportadora",
  "defensivo",
] as const;

function EditarCliente() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const novo = id === "novo";

  const [cliente, setCliente] = useState<Partial<Cliente>>(vazio);
  const [clienteId, setClienteId] = useState<string | null>(novo ? null : id);
  const [dominios, setDominios] = useState<Dominio[]>([]);
  const [modulos, setModulos] = useState<Modulo[]>([]);
  const [definicaoModulos, setDefinicaoModulos] = useState<string | null>(null);
  const [novoDominio, setNovoDominio] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [filtroDominio, setFiltroDominio] = useState("");
  const [ordemDominios, setOrdemDominios] = useState<"original" | "asc" | "desc">("original");

  const dominiosVisiveis = useMemo(() => {
    const termo = filtroDominio.trim().toLowerCase();
    let lista = Array.isArray(dominios) ? dominios : [];
    if (termo) {
      lista = lista.filter((d) => (d.dominio ?? "").toLowerCase().includes(termo));
    }
    if (ordemDominios === "asc" || ordemDominios === "desc") {
      lista = [...lista].sort((a, b) => {
        const valA = a.dominio ?? "";
        const valB = b.dominio ?? "";
        const comp = valA.localeCompare(valB, "pt-BR", { sensitivity: "base", numeric: true });
        return ordemDominios === "asc" ? comp : -comp;
      });
    }
    return lista;
  }, [dominios, filtroDominio, ordemDominios]);

  const carregarDominios = async (cid: string) => {
    const { data, error } = await getClient()
      .from("dominios")
      .select("*")
      .eq("cliente_id", cid)
      .order("created_at", { ascending: true });
    if (error) setErro(error.message);
    else setDominios((data ?? []) as Dominio[]);
  };

  const carregarModulos = async () => {
    const { data, error } = await getClient().from("modulos").select("*").order("nome", { ascending: true });
    if (error) {
      setDefinicaoModulos(null);
      return;
    }
    if (data && data.length > 0) {
      setModulos(data as Modulo[]);
      setDefinicaoModulos("modulos");
    } else {
      setDefinicaoModulos("constante");
    }
  };

  useEffect(() => {
    carregarModulos();
    if (novo) return;
    getClient()
      .from("clientes")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (error) setErro(error.message);
        else if (data) {
          const rawCli = data as Cliente;
          const produtoFinal: ProdutoTipo =
            rawCli.produto && rawCli.produto.toString().toLowerCase() === "silun"
              ? "Silun"
              : "MeuPedix";
          setCliente({ ...rawCli, produto: produtoFinal });
          carregarDominios(id);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const opcoesModulos = useMemo(() => {
    const slugs: string[] = [];
    const tempo: Modulo[] = [];
    for (const m of modulos) {
      if (m.slug && m.slug.trim()) {
        slugs.push(m.slug.trim().toLowerCase());
        tempo.push(m);
      }
    }
    if (definicaoModulos !== "modulos") {
      for (const s of SLUGS_MODULOS_PADRAO) {
        if (!slugs.includes(s)) {
          slugs.push(s);
          tempo.push({ id: s, slug: s, nome: s, descricao: null, cor_icone: null, arquivo_svg: null });
        }
      }
    }
    return { slugs, tempo };
  }, [modulos, definicaoModulos]);

  const campo = <K extends keyof Cliente>(key: K, value: Cliente[K]) => setCliente((c) => ({ ...c, [key]: value }));

  const toggleModulo = (slug: string) => {
    setCliente((c) => {
      const atual = Array.isArray(c.modulos_contratados) ? c.modulos_contratados : [];
      const updated = atual.includes(slug) ? atual.filter((s) => s !== slug) : [...atual, slug];
      return { ...c, modulos_contratados: updated };
    });
  };

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    setMsg(null);

    if (!cliente.produto) {
      setErro("Selecione um produto.");
      setSalvando(false);
      return;
    }

    const payloadCore = {
      produto: (cliente.produto ?? "MeuPedix").toLowerCase(),
      nome_fantasia: cliente.nome_fantasia || null,
      contato: cliente.contato || null,
      telefone: cliente.telefone || null,
      email_contato: cliente.email_contato || null,
      valor_mensal: cliente.valor_mensal ?? null,
      dia_vencimento: cliente.dia_vencimento ?? null,
      status_pagamento: cliente.status_pagamento ?? null,
      observacoes: cliente.observacoes || null,
      ativo: cliente.ativo ?? true,
      empresa_id: cliente.empresa_id || null,
      email_login_supabase: cliente.email_login_supabase || null,
      supabase_url: cliente.supabase_url || null,
      supabase_anon_key: cliente.supabase_anon_key || null,
      modulos_contratados: cliente.modulos_contratados || [],
      modo: cliente.modo ?? "compartilhado",
    };

    if (clienteId) {
      const { error } = await getClient().from("clientes").update(payloadCore).eq("id", clienteId);
      if (error) {
        setErro(error.message);
        setSalvando(false);
        return;
      }
    } else {
      const { data, error } = await getClient().from("clientes").insert(payloadCore).select().maybeSingle();
      if (error || !data) {
        setErro(error?.message || "Erro ao criar cliente.");
        setSalvando(false);
        return;
      }
      const criado = data as Cliente;
      const novoId = String(criado.id);
      setClienteId(novoId);
      setCliente(criado);
    }

    setMsg("Alterações salvas.");
    setSalvando(false);
  };

  const adicionarDominio = async () => {
    if (!clienteId || !novoDominio.trim()) return;
    const { error } = await getClient()
      .from("dominios")
      .insert({ cliente_id: clienteId, dominio: novoDominio.trim(), modulo: cliente.produto?.toLowerCase() ?? "meupedix" });
    if (error) setErro(error.message);
    else {
      setNovoDominio("");
      carregarDominios(clienteId);
    }
  };

  const salvarDominio = async (dominioId: string, valor: string, modulo: string | null, isPrimary: boolean) => {
    const { error } = await getClient()
      .from("dominios")
      .update({ dominio: valor.trim() || null, modulo: modulo || null, is_primary: isPrimary })
      .eq("id", dominioId);
    if (error) setErro(error.message);
    else setMsg("Domínio atualizado.");
  };

  const removerDominio = async (dominioId: string) => {
    const { error } = await getClient().from("dominios").delete().eq("id", dominioId);
    if (error) setErro(error.message);
    else if (clienteId) carregarDominios(clienteId);
  };

  const excluirCliente = async () => {
    if (!clienteId || !confirm("Excluir este cliente e seus dados vinculados?")) return;
    await getClient().from("dominios").delete().eq("cliente_id", clienteId);
    const { error } = await getClient().from("clientes").delete().eq("id", clienteId);
    if (error) setErro(error.message);
    else navigate({ to: "/" });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-muted-foreground hover:underline">
            ← Voltar
          </Link>
          <h1 className="text-xl font-semibold text-foreground">{clienteId ? cliente.nome_fantasia || "Cliente" : "Novo cliente"}</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="ativo" checked={!!cliente.ativo} onCheckedChange={(v) => campo("ativo", v)} />
            <Label htmlFor="ativo">{cliente.ativo ? "Ativo" : "Inativo"}</Label>
          </div>
          <Button onClick={salvar} disabled={salvando}>
            {salvando ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </div>

      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      <section className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="produto">
            Produto <span className="text-destructive">*</span>
          </Label>
          <select
            id="produto"
            disabled={!novo}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={cliente.produto ?? "MeuPedix"}
            onChange={(e) => campo("produto", e.target.value as ProdutoTipo)}
          >
            <option value="MeuPedix">MeuPedix</option>
            <option value="Silun">Silun</option>
          </select>
          {!novo && (
            <p className="text-xs text-muted-foreground">O produto não pode ser alterado após a criação.</p>
          )}
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="nome">Nome fantasia</Label>
          <Input id="nome" value={cliente.nome_fantasia ?? ""} onChange={(e) => campo("nome_fantasia", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="contato">Contato</Label>
          <Input id="contato" value={cliente.contato ?? ""} onChange={(e) => campo("contato", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="telefone">Número de telefone</Label>
          <Input id="telefone" value={cliente.telefone ?? ""} onChange={(e) => campo("telefone", e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="emailc">E-mail do contato</Label>
          <Input id="emailc" type="email" value={cliente.email_contato ?? ""} onChange={(e) => campo("email_contato", e.target.value)} />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="modo">Modo</Label>
          <select
            id="modo"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={cliente.modo ?? "compartilhado"}
            onChange={(e) => campo("modo", e.target.value as ModoTipo)}
          >
            {OPCOES_MODO.map((m) => (
              <option key={m} value={m}>
                {m === "compartilhado" ? "Compartilhado" : "Individual"}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="emails">E-mail do login do Supabase</Label>
          <Input
            id="emails"
            type="email"
            value={cliente.email_login_supabase ?? ""}
            onChange={(e) => campo("email_login_supabase", e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="surl">Supabase URL</Label>
          <Input id="surl" value={cliente.supabase_url ?? ""} onChange={(e) => campo("supabase_url", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skey">Supabase anon key</Label>
          <Input
            id="skey"
            value={cliente.supabase_anon_key ?? ""}
            onChange={(e) => campo("supabase_anon_key", e.target.value)}
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="empresa_id">ID da empresa (Silun)</Label>
          <Input
            id="empresa_id"
            placeholder="ex: 123e4567-e89b-12d3-a456-426614174000"
            value={cliente.empresa_id ?? ""}
            onChange={(e) => campo("empresa_id", e.target.value)}
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label>Módulos contratados</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 pt-1">
            {opcoesModulos.tempo.map((modulo) => {
              const modulosContratados = Array.isArray(cliente.modulos_contratados) ? cliente.modulos_contratados : [];
              const checked = modulosContratados.includes(modulo.slug);
              return (
                <label key={modulo.slug} className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                  <Checkbox checked={checked} onCheckedChange={() => toggleModulo(modulo.slug)} />
                  <span>{modulo.nome}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="valor">Valor mensal</Label>
          <Input
            id="valor"
            type="number"
            step="0.01"
            value={cliente.valor_mensal ?? ""}
            onChange={(e) => campo("valor_mensal", e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="venc">Dia de vencimento</Label>
          <Input
            id="venc"
            type="number"
            min={1}
            max={31}
            value={cliente.dia_vencimento ?? ""}
            onChange={(e) => campo("dia_vencimento", e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pag">Status de pagamento</Label>
          <select
            id="pag"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={cliente.status_pagamento ?? "em_dia"}
            onChange={(e) => campo("status_pagamento", e.target.value)}
          >
            <option value="em_dia">Em dia</option>
            <option value="atrasado">Atrasado</option>
            <option value="cancelado">Cancelado</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="obs">Observações</Label>
          <Textarea id="obs" rows={4} value={cliente.observacoes ?? ""} onChange={(e) => campo("observacoes", e.target.value)} />
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium text-foreground">Domínios</h2>
        {!clienteId && <p className="text-sm text-muted-foreground">Salve o cliente para adicionar domínios.</p>}
        {clienteId && (
          <>
            <div className="flex gap-2">
              <Input placeholder="exemplo.com.br" value={novoDominio} onChange={(e) => setNovoDominio(e.target.value)} />
              <Button variant="secondary" onClick={adicionarDominio}>
                Adicionar
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Filtrar domínios"
                placeholder="Filtrar domínios..."
                value={filtroDominio}
                onChange={(e) => setFiltroDominio(e.target.value)}
                className="max-w-xs"
              />
              <select
                aria-label="Ordenar domínios"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={ordemDominios}
                onChange={(e) => setOrdemDominios(e.target.value as "original" | "asc" | "desc")}
              >
                <option value="original">Ordem original</option>
                <option value="asc">A → Z</option>
                <option value="desc">Z → A</option>
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Alternar ordenação por domínio"
                onClick={() => setOrdemDominios((prev) => (prev === "desc" ? "asc" : "desc"))}
              >
                {ordemDominios !== "desc" ? "Domínio ↑" : "Domínio ↓"}
              </Button>
            </div>
            <ul className="divide-y rounded-md border">
              {dominiosVisiveis?.map((d) => {
                const urlDominio = d.dominio?.startsWith("http") ? d.dominio : `https://${d.dominio ?? ""}`;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <div className="flex min-w-[280px] flex-1 items-center gap-2">
                      <Checkbox
                        checked={d.is_primary ?? false}
                        onCheckedChange={(checked) => {
                          const val = !!checked;
                          setDominios((lista) =>
                            lista.map((x) => (x.id === d.id ? { ...x, is_primary: val } : x)),
                          );
                          salvarDominio(String(d.id), d.dominio ?? "", d.modulo, val);
                        }}
                      />
                      <Input
                        value={d.dominio ?? ""}
                        onChange={(e) =>
                          setDominios((lista) =>
                            lista.map((x) => (x.id === d.id ? { ...x, dominio: e.target.value } : x)),
                          )
                        }
                        onBlur={(e) => salvarDominio(String(d.id), e.target.value, d.modulo, d.is_primary ?? false)}
                      />
                      <select
                        aria-label="Módulo do domínio"
                        className="h-9 w-40 shrink-0 rounded-md border border-input bg-background px-3 text-sm"
                        value={d.modulo ?? ""}
                        onChange={(e) => {
                          const valor = e.target.value || null;
                          setDominios((lista) =>
                            lista.map((x) => (x.id === d.id ? { ...x, modulo: valor } : x)),
                          );
                          salvarDominio(String(d.id), d.dominio ?? "", valor, d.is_primary ?? false);
                        }}
                      >
                        <option value="">— sem módulo —</option>
                        {opcoesModulos.slugs.map((s: string) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => salvarDominio(String(d.id), d.dominio ?? "", d.modulo, d.is_primary ?? false)}>
                      Salvar
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <a href={urlDominio} target="_blank" rel="noopener noreferrer">
                        Abrir
                      </a>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removerDominio(String(d.id))}>
                      Remover
                    </Button>
                  </li>
                );
              })}
              {dominios.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">Nenhum domínio vinculado.</li>}
              {dominios.length > 0 && dominiosVisiveis.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">Nenhum domínio encontrado.</li>
              )}
            </ul>
          </>
        )}
      </section>

      {clienteId && (
        <Button variant="destructive" onClick={excluirCliente}>
          Excluir cliente
        </Button>
      )}
    </div>
  );
}
