import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PainelLayout } from "@/components/PainelLayout";
import { getClient, type Cliente, type Dominio } from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

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
  nome_fantasia: "",
  contato: "",
  telefone: "",
  email_contato: "",
  email_login_supabase: "",
  supabase_url: "",
  supabase_anon_key: "",
  valor_mensal: null,
  dia_vencimento: null,
  status_pagamento: "em_dia",
  observacoes: "",
  ativo: true,
};

function EditarCliente() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const novo = id === "novo";

  const [cliente, setCliente] = useState<Partial<Cliente>>(vazio);
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
      .then(({ data, error }) => {
        if (error) setErro(error.message);
        else if (data) setCliente(data as Cliente);
      });
    carregarDominios(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const campo = <K extends keyof Cliente>(key: K, value: Cliente[K]) => setCliente((c) => ({ ...c, [key]: value }));

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    setMsg(null);
    const payload = {
      nome_fantasia: cliente.nome_fantasia || null,
      contato: cliente.contato || null,
      telefone: cliente.telefone || null,
      email_contato: cliente.email_contato || null,
      email_login_supabase: cliente.email_login_supabase || null,
      supabase_url: cliente.supabase_url || null,
      supabase_anon_key: cliente.supabase_anon_key || null,
      valor_mensal: cliente.valor_mensal ?? null,
      dia_vencimento: cliente.dia_vencimento ?? null,
      status_pagamento: cliente.status_pagamento ?? null,
      observacoes: cliente.observacoes || null,
      ativo: cliente.ativo ?? true,
    };

    if (clienteId) {
      const { error } = await getClient().from("clientes").update(payload).eq("id", clienteId);
      if (error) setErro(error.message);
      else setMsg("Alterações salvas.");
    } else {
      const { data, error } = await getClient().from("clientes").insert(payload).select().maybeSingle();
      if (error) setErro(error.message);
      else if (data) {
        const criado = data as Cliente;
        setClienteId(String(criado.id));
        setCliente(criado);
        setMsg("Cliente criado. Agora adicione os domínios abaixo.");
      }
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
    if (!clienteId || !confirm("Excluir este cliente e seus domínios?")) return;
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
        <div className="space-y-1">
          <Label htmlFor="emailc">E-mail do contato</Label>
          <Input id="emailc" type="email" value={cliente.email_contato ?? ""} onChange={(e) => campo("email_contato", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="emails">E-mail do login do Supabase</Label>
          <Input id="emails" type="email" value={cliente.email_login_supabase ?? ""} onChange={(e) => campo("email_login_supabase", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="surl">Supabase URL</Label>
          <Input id="surl" value={cliente.supabase_url ?? ""} onChange={(e) => campo("supabase_url", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skey">Supabase anon key</Label>
          <Input id="skey" value={cliente.supabase_anon_key ?? ""} onChange={(e) => campo("supabase_anon_key", e.target.value)} />
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
        <div className="space-y-1">
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
            <ul className="divide-y rounded-md border">
              {dominios.map((d) => (
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
                  <Button variant="ghost" size="sm" onClick={() => removerDominio(String(d.id))}>
                    Remover
                  </Button>
                </li>
              ))}
              {dominios.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">Nenhum domínio vinculado.</li>}
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
