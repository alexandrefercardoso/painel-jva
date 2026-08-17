import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PainelLayout } from "@/components/PainelLayout";
import {
  getClient,
  type Cliente,
  type ClienteMeuPedix,
  type ClienteSilun,
  type Dominio,
  type ProdutoTipo,
  OPCOES_MODULOS_SILUN,
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
};

const meupedixVazio: Partial<ClienteMeuPedix> = {
  email_login_supabase: "",
  supabase_url: "",
  supabase_anon_key: "",
};

const silunVazio: Partial<ClienteSilun> = {
  empresa_id: "",
  modulos_contratados: [],
};

function EditarCliente() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const novo = id === "novo";

  const [cliente, setCliente] = useState<Partial<Cliente>>(vazio);
  const [meupedix, setMeuPedix] = useState<Partial<ClienteMeuPedix>>(meupedixVazio);
  const [silun, setSilun] = useState<Partial<ClienteSilun>>(silunVazio);
  const [clienteId, setClienteId] = useState<string | null>(novo ? null : id);
  const [dominios, setDominios] = useState<Dominio[]>([]);
  const [novoDominio, setNovoDominio] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregarDominios = async (cid: string) => {
    const { data, error } = await getClient().from("dominios").select("*").eq("cliente_id", cid);
    if (error) setErro(error.message);
    else setDominios((data ?? []) as Dominio[]);
  };

  useEffect(() => {
    if (novo) return;
    getClient()
      .from("clientes")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (error) setErro(error.message);
        else if (data) {
          const rawCli = data as Cliente & {
            email_login_supabase?: string | null;
            supabase_url?: string | null;
            supabase_anon_key?: string | null;
          };
          const produtoFinal: ProdutoTipo =
            rawCli.produto && rawCli.produto.toString().toLowerCase() === "silun"
              ? "Silun"
              : "MeuPedix";
          const cli: Cliente = { ...rawCli, produto: produtoFinal };
          setCliente(cli);

          if (produtoFinal === "MeuPedix") {
            const { data: mpData, error: mpErr } = await getClient()
              .from("clientes_meupedix")
              .select("*")
              .eq("cliente_id", id)
              .maybeSingle();
            if (mpErr) setErro(mpErr.message);
            else if (mpData) {
              setMeuPedix(mpData as ClienteMeuPedix);
            } else {
              setMeuPedix({
                email_login_supabase: rawCli.email_login_supabase ?? "",
                supabase_url: rawCli.supabase_url ?? "",
                supabase_anon_key: rawCli.supabase_anon_key ?? "",
              });
            }
            carregarDominios(id);
          } else if (produtoFinal === "Silun") {
            const { data: slData, error: slErr } = await getClient()
              .from("clientes_silun")
              .select("*")
              .eq("cliente_id", id)
              .maybeSingle();
            if (slErr) setErro(slErr.message);
            else if (slData) setSilun(slData as ClienteSilun);
          }
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const campo = <K extends keyof Cliente>(key: K, value: Cliente[K]) => setCliente((c) => ({ ...c, [key]: value }));

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
    };

    let cid = clienteId;
    if (cid) {
      const { error } = await getClient().from("clientes").update(payloadCore).eq("id", cid);
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
      cid = String(criado.id);
      setClienteId(cid);
      setCliente(criado);
    }

    if (cliente.produto === "MeuPedix") {
      const payloadMp = {
        cliente_id: cid,
        email_login_supabase: meupedix.email_login_supabase || null,
        supabase_url: meupedix.supabase_url || null,
        supabase_anon_key: meupedix.supabase_anon_key || null,
      };
      const { error: mpErr } = await getClient()
        .from("clientes_meupedix")
        .upsert(payloadMp, { onConflict: "cliente_id" });
      if (mpErr) setErro(mpErr.message);
      else setMsg("Alterações salvas.");
    } else if (cliente.produto === "Silun") {
      const payloadSl = {
        cliente_id: cid,
        empresa_id: silun.empresa_id || null,
        modulos_contratados: silun.modulos_contratados || [],
      };
      const { error: slErr } = await getClient()
        .from("clientes_silun")
        .upsert(payloadSl, { onConflict: "cliente_id" });
      if (slErr) setErro(slErr.message);
      else setMsg("Alterações salvas.");
    }

    setSalvando(false);
  };

  const adicionarDominio = async () => {
    if (!clienteId || !novoDominio.trim()) return;
    const { error } = await getClient()
      .from("dominios")
      .insert({ cliente_id: clienteId, dominio: novoDominio.trim() });
    if (error) setErro(error.message);
    else {
      setNovoDominio("");
      carregarDominios(clienteId);
    }
  };

  const salvarDominio = async (dominioId: string, valor: string) => {
    const { error } = await getClient()
      .from("dominios")
      .update({ dominio: valor.trim() || null })
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
    await getClient().from("clientes_meupedix").delete().eq("cliente_id", clienteId);
    await getClient().from("clientes_silun").delete().eq("cliente_id", clienteId);
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

        {cliente.produto === "MeuPedix" && (
          <>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="emails">E-mail do login do Supabase</Label>
              <Input
                id="emails"
                type="email"
                value={meupedix.email_login_supabase ?? ""}
                onChange={(e) => setMeuPedix((prev) => ({ ...prev, email_login_supabase: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="surl">Supabase URL</Label>
              <Input
                id="surl"
                value={meupedix.supabase_url ?? ""}
                onChange={(e) => setMeuPedix((prev) => ({ ...prev, supabase_url: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="skey">Supabase anon key</Label>
              <Input
                id="skey"
                value={meupedix.supabase_anon_key ?? ""}
                onChange={(e) => setMeuPedix((prev) => ({ ...prev, supabase_anon_key: e.target.value }))}
              />
            </div>
          </>
        )}

        {cliente.produto === "Silun" && (
          <>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="empresa_id">ID da empresa (Silun)</Label>
              <Input
                id="empresa_id"
                placeholder="ex: 123e4567-e89b-12d3-a456-426614174000"
                value={silun.empresa_id ?? ""}
                onChange={(e) => setSilun((prev) => ({ ...prev, empresa_id: e.target.value }))}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Módulos contratados</Label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 pt-1">
                {OPCOES_MODULOS_SILUN.map((modulo) => {
                  const modulos = silun.modulos_contratados || [];
                  const checked = modulos.includes(modulo);
                  return (
                    <label key={modulo} className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(isOptionsChecked) => {
                          const updated = isOptionsChecked
                            ? [...modulos, modulo]
                            : modulos.filter((m) => m !== modulo);
                          setSilun((prev) => ({ ...prev, modulos_contratados: updated }));
                        }}
                      />
                      <span>{modulo}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

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

      {cliente.produto === "MeuPedix" && (
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
              <ul className="divide-y rounded-md border">
                {dominios.map((d) => {
                  const urlDominio = d.dominio?.startsWith("http") ? d.dominio : `https://${d.dominio ?? ""}`;
                  return (
                    <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <Input
                        value={d.dominio ?? ""}
                        onChange={(e) =>
                          setDominios((lista) =>
                            lista.map((x) => (x.id === d.id ? { ...x, dominio: e.target.value } : x)),
                          )
                        }
                        onBlur={(e) => salvarDominio(String(d.id), e.target.value)}
                      />
                      <Button variant="secondary" size="sm" onClick={() => salvarDominio(String(d.id), d.dominio ?? "")}>
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
              </ul>
            </>
          )}
        </section>
      )}

      {clienteId && (
        <Button variant="destructive" onClick={excluirCliente}>
          Excluir cliente
        </Button>
      )}
    </div>
  );
}
