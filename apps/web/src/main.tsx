import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Region = 'south' | 'center' | 'north';
type Supplier = 'SUP-REST' | 'SUP-SOAP';
type Role = 'admin' | 'buyer';
type User = {id:string;displayName:string;role:Role;region:Region|null};
type Session = {token:string;user:User};
type Stock = { region:Region;product_id:string;sku:string;name:string;supplier_id:Supplier;on_hand:number;minimum_stock:number;target_stock:number;incoming_qty:number};
type Item = {region:Region;productId:string;quantity:number};
type Order = {id:string;batch_id:string;supplier_id:Supplier;items:Item[];status:string;created_by:string;origin_region:Region|null;retry_count:number;last_error:string|null;invoice_path:string|null;created_at:string;updated_at:string};
type Receipt = {order_id:string;product_id:string;region:Region;quantity:number;received_by:string;received_at:string};
type NodeInfo = {region:Region;streaming_replicas:number;prepared_transactions:number;standby:boolean};
type Audit = {id:number;event_type:string;order_id:string|null;occurred_at:string;details:unknown};
type ApiEnvelope<T> = {success:boolean;data:T;message?:string};
type Tab = 'overview'|'new-order'|'orders'|'stock'|'receipts'|'infrastructure'|'catalogue';
const names:Record<Region,string>={south:'Maputo · Sul',center:'Beira · Centro',north:'Nampula · Norte'};
const short = (id:string) => id.length>18?id.slice(0,15)+'…':id;
const date = (s:string)=>new Date(s).toLocaleString('pt-PT',{dateStyle:'short',timeStyle:'short'});
const idForBatch=()=>`WEB-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
const statusLabel:Record<string,string>={PENDING_SUPPLIER:'Pendente',SENDING:'A enviar',CONFIRMED:'Confirmada',TX_COMMITTING:'Em transacção'};
const getSession=():Session|null=>{try {const v=sessionStorage.getItem('scad-session');return v?JSON.parse(v) as Session:null;}catch{return null;}};
async function request<T>(token:string,path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(`/api${path}`,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers}});
  const body=await response.json() as ApiEnvelope<T>;
  if(!response.ok||!body.success)throw new Error(body.message||`HTTP ${response.status}`);
  return body.data;
}
function AuthView({onLogin}:{onLogin:(v:Session)=>void}){
  const [username,setUsername]=useState('buyer-south');
  const [password,setPassword]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  async function submit(e:React.FormEvent){
    e.preventDefault();setLoading(true);setError('');
    try{
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      const body=await r.json() as ApiEnvelope<Session>;
      if(!r.ok||!body.success)throw new Error(body.message||'Não foi possível iniciar sessão');
      onLogin(body.data);
    }catch(err){setError((err as Error).message);}finally{setLoading(false);}
  }
  return <div className="login-shell"><div className="login-decoration"><div className="brand-badge">SC</div><div className="login-copy"><div className="kicker kicker-light">ISUTC · SISTEMAS DISTRIBUÍDOS E PARALELOS</div><h1>Compras coordenadas.<br/><span>Centros conectados.</span></h1><p>Uma plataforma de reposição que reúne três armazéns, fornecedores REST/SOAP e coordenação distribuída num único fluxo de trabalho.</p></div><div className="login-foot"><span>● Cluster regional</span><span>● PostgreSQL + 2PC</span><span>● et​cd</span></div></div><div className="login-panel"><div className="login-card"><span className="mini-logo">S</span><div className="kicker">PORTAL DE OPERAÇÕES</div><h2>Iniciar sessão</h2><p>Selecciona o teu centro ou entra como administrador para acompanhar todos os armazéns.</p><form onSubmit={submit} className="form-stack"><label>Utilizador<select value={username} onChange={e=>setUsername(e.target.value)}><option value="buyer-south">Comprador — Maputo</option><option value="buyer-center">Comprador — Beira</option><option value="buyer-north">Comprador — Nampula</option><option value="admin">Administrador SCAD</option></select></label><label>Palavra-passe<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required placeholder="Introduza a palavra-passe"/></label>{error&&<div className="notice error">{error}</div>}<button className="btn primary full" disabled={loading}>{loading?'A autenticar…':'Entrar no sistema →'}</button></form><div className="login-note">Ambiente académico · Contas configuradas no ficheiro <code>.env</code> do servidor.</div></div></div></div>;
}

function App(){
  const [session,setSession]=useState<Session|null>(getSession);
  const [tab,setTab]=useState<Tab>('overview');
  const [stocks,setStocks]=useState<Stock[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [receipts,setReceipts]=useState<Receipt[]>([]);
  const [nodes,setNodes]=useState<NodeInfo[]>([]);
  const [audit,setAudit]=useState<Audit[]>([]);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [flash,setFlash]=useState<{type:'success'|'error';text:string}|null>(null);
  const [refreshed,setRefreshed]=useState('—');
  const [supplier,setSupplier]=useState<Supplier>('SUP-REST');
  const [batch,setBatch]=useState(idForBatch);
  const [lines,setLines]=useState<Array<{key:string;quantity:number}>>([{key:'',quantity:1}]);
  const [search,setSearch]=useState('');
  const [filterStatus,setFilterStatus]=useState('all');
  const [newProduct,setNewProduct]=useState({region:'south' as Region,productId:'',sku:'',name:'',supplierId:'SUP-REST' as Supplier,onHand:10,minimumStock:5,targetStock:20});
  const user=session?.user;
  const isAdmin=user?.role==='admin';
  const token=session?.token||'';
  const saveSession=(s:Session)=>{sessionStorage.setItem('scad-session',JSON.stringify(s));setSession(s);setTab('overview');};
  const logout=()=>{sessionStorage.removeItem('scad-session');setSession(null);setStocks([]);setOrders([]);setReceipts([]);setFlash(null);};
  const refresh=useCallback(async()=>{
    if(!session)return;
    try{
      const [s,o,r]=await Promise.all([request<Stock[]>(session.token,'/stocks'),request<Order[]>(session.token,'/purchases'),request<Receipt[]>(session.token,'/receipts')]);
      setStocks(s);setOrders(o);setReceipts(r);
      if(session.user.role==='admin'){
        const [n,a]=await Promise.all([request<NodeInfo[]>(session.token,'/cluster'),request<Audit[]>(session.token,'/audit')]);
        setNodes(n);setAudit(a);
      }
      setRefreshed(new Date().toLocaleTimeString('pt-PT'));
    }catch(err){setFlash({type:'error',text:`Sincronização: ${(err as Error).message}`});}
    finally{setLoading(false);}
  },[session]);
  useEffect(()=>{if(!session){setLoading(false);return;}void refresh();const t=setInterval(()=>void refresh(),8000);return()=>clearInterval(t);},[session,refresh]);
  async function act(job:()=>Promise<string>){
    setBusy(true);setFlash(null);
    try{const msg=await job();setFlash({type:'success',text:msg});await refresh();}
    catch(err){setFlash({type:'error',text:(err as Error).message});}
    finally{setBusy(false);}
  }
  const eligible=useMemo(()=>stocks.filter(s=>s.supplier_id===supplier),[stocks,supplier]);
  const low=stocks.filter(s=>s.on_hand+s.incoming_qty<=s.minimum_stock).length;
  const confirmed=orders.filter(o=>o.status==='CONFIRMED').length;
  const pending=orders.length-confirmed;
  const visibleOrders=orders.filter(o=>{
    const txt=[o.id,o.batch_id,o.supplier_id,o.created_by,...o.items.map(x=>x.productId)].join(' ').toLowerCase();
    return txt.includes(search.toLowerCase())&&(filterStatus==='all'||o.status===filterStatus);
  });
  const received=(order:Order,region:Region)=>{
    const its=order.items.filter(i=>i.region===region);
    return !!its.length && its.every(i=>receipts.some(r=>r.order_id===order.id&&r.region===region&&r.product_id===i.productId));
  };
  const orderRegions=(o:Order)=>[...new Set(o.items.map(i=>i.region))];
  async function createOrder(e:React.FormEvent){
    e.preventDefault();
    await act(async()=>{
      const items=lines.map(line=>{
        const found=eligible.find(s=>`${s.region}|${s.product_id}`===line.key);
        if(!found)throw new Error('Selecciona produtos válidos para o fornecedor.');
        if(!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>500)throw new Error('Quantidade permitida: 1–500 unidades.');
        return {region:found.region,productId:found.product_id,quantity:line.quantity};
      });
      if(new Set(lines.map(i=>i.key)).size!==lines.length)throw new Error('Não repitas o mesmo produto e centro.');
      const result=await request<Order>(token,'/purchases',{method:'POST',body:JSON.stringify({supplierId:supplier,batchId:batch,items})});
      setBatch(idForBatch());setLines([{key:'',quantity:1}]);setTab('orders');
      return `Encomenda ${short(result.id)} registada. O fornecedor confirmará de forma assíncrona.`;
    });
  }
  function invoice(order:Order){
    void act(async()=>{
      const r=await fetch(`/api/purchases/${order.id}/invoice`,{headers:{Authorization:`Bearer ${token}`}});
      if(!r.ok)throw new Error('A factura ainda não está disponível.');
      const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');
      a.href=url;a.download=`factura-${order.batch_id}.pdf`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      return 'Factura descarregada.';
    });
  }
  function receive(o:Order,region:Region){
    void act(async()=>{
      const data=await request<{receivedItems:number;alreadyReceived:boolean}>(token,`/purchases/${o.id}/receive`,{method:'POST',body:JSON.stringify({region})});
      return data.alreadyReceived?'Recepção já registada.':`Recepção registada em ${names[region]}: ${data.receivedItems} produto(s).`;
    });
  }
  if(!session)return <AuthView onLogin={saveSession}/>;
  const nav:Array<{key:Tab;label:string;symbol:string;admin?:boolean}>=[
    {key:'overview',label:'Visão geral',symbol:'◫'},
    {key:'new-order',label:'Nova encomenda',symbol:'＋'},
    {key:'orders',label:'Encomendas',symbol:'▤'},
    {key:'stock',label:'Inventário',symbol:'▦'},
    {key:'receipts',label:'Recepções',symbol:'✓'},
    {key:'catalogue',label:'Adicionar produto',symbol:'⊞',admin:true},
    {key:'infrastructure',label:'Infraestrutura',symbol:'◎',admin:true},
  ];
  return <div className="app-shell"><aside className="sidebar">
    <div className="brand"><div className="brand-symbol">S</div><div><strong>SCAD</strong><span>COORDENA</span></div></div>
    <div className="menu-label">ESPAÇO DE TRABALHO</div>
    <nav className="side-nav">{nav.filter(n=>!n.admin||isAdmin).map(n=><button key={n.key} className={`nav-item ${tab===n.key?'active':''}`} onClick={()=>{setTab(n.key);setFlash(null);}}><span className="nav-symbol">{n.symbol}</span>{n.label}{n.key==='orders'&&<b>{orders.length}</b>}</button>)}</nav>
    <div className="sidebar-info"><div className="health-led"/> Ambiente de laboratório<div className="sidebar-small">3 regiões · REST e SOAP · 2PC</div></div>
    <div className="sidebar-profile"><div className="avatar">{user?.displayName.charAt(0)}</div><div><strong>{user?.displayName}</strong><span>{isAdmin?'Visão global':names[user!.region!]}</span></div><button className="logout" title="Terminar sessão" onClick={logout}>↪</button></div>
  </aside><main className="main">
    <header className="topbar"><div><span className="kicker">ISUTC / SISTEMAS DISTRIBUÍDOS E PARALELOS</span><div className="top-subtitle">Portal de operação · {isAdmin?'Administração central':names[user!.region!]}</div></div><div className="top-actions"><span className="last-update">Actualizado às {refreshed}</span><button className="btn ghost" onClick={()=>void refresh()} disabled={loading}>↻ Actualizar</button></div></header>
    <div className="workspace">
    {flash&&<div role="alert" className={`notice ${flash.type}`}><strong>{flash.type==='success'?'Operação concluída':'Atenção'}</strong><span>{flash.text}</span><button onClick={()=>setFlash(null)} aria-label="Fechar">×</button></div>}
    {tab==='overview'&&<>
      <div className="page-lead"><div><div className="kicker">PAINEL OPERACIONAL</div><h1>{isAdmin?'Visão geral do sistema':`Centro de ${names[user!.region!].split(' · ')[0]}`}</h1><p>Stock, compras e recepção de mercadorias com actualização automática.</p></div><button className="btn primary" onClick={()=>setTab('new-order')}>＋ Nova encomenda</button></div>
      <div className="metric-grid"><Metric title={isAdmin?'Centros activos':'Meu centro'} value={isAdmin?'03':'01'} extra="Rede regional" icon="◉"/><Metric title="Alertas de stock" value={String(low).padStart(2,'0')} extra="No mínimo ou abaixo" icon="!" warning={low>0}/><Metric title="Encomendas confirmadas" value={String(confirmed).padStart(2,'0')} extra="Aprovadas pelo fornecedor" icon="✓"/><Metric title="Em processamento" value={String(pending).padStart(2,'0')} extra="Aguardam confirmação" icon="↗"/></div>
      <div className="columns two"><section className="card"><div className="card-heading"><div><h2>Inventário em atenção</h2><p>Produtos que exigem monitorização.</p></div><button className="text-button" onClick={()=>setTab('stock')}>Ver inventário →</button></div><div className="list-items">{stocks.filter(s=>s.on_hand+s.incoming_qty<=s.minimum_stock).slice(0,6).map(s=><div className="list-row" key={`${s.region}${s.product_id}`}><div className="item-icon">▣</div><div className="grow"><strong>{s.name}</strong><small>{names[s.region]} · {s.product_id}</small></div><span className="tag amber">{s.on_hand} em stock</span></div>)}{!low&&<div className="empty">Não existem alertas de stock.</div>}</div></section><section className="card"><div className="card-heading"><div><h2>Últimas encomendas</h2><p>Estado actualizado de cada operação.</p></div><button className="text-button" onClick={()=>setTab('orders')}>Ver todas →</button></div><div className="list-items">{orders.slice(0,6).map(o=><div className="list-row" key={o.id}><div className="item-icon order">↗</div><div className="grow"><strong>{short(o.batch_id)}</strong><small>{o.supplier_id} · {date(o.created_at)}</small></div><Status value={o.status}/></div>)}{!orders.length&&<div className="empty">Ainda não existem encomendas.</div>}</div></section></div>
      <div className="tip"><b>Como funciona?</b> O centro cria uma encomenda → o coordenador protege o lote com etcd → PostgreSQL confirma a transacção → o fornecedor responde → o comprador regista a recepção física.</div>
    </>}
    {tab==='new-order'&&<><PageTitle eyebrow="COMPRAS / CRIAÇÃO" title="Nova encomenda" sub={isAdmin?'Consolida compras de um ou vários centros.':'Regista uma encomenda destinada exclusivamente ao teu centro.'}/><div className="columns purchase-layout"><section className="card padded"><form onSubmit={e=>void createOrder(e)} className="form-stack"><div className="section-heading"><span className="step-num">01</span><div><h2>Dados gerais</h2><p>Fornecedor e identificação única da encomenda.</p></div></div><div className="form-grid"><label>Fornecedor<select value={supplier} onChange={e=>{setSupplier(e.target.value as Supplier);setLines([{key:'',quantity:1}]);}}><option value="SUP-REST">SUP-REST · REST / JSON</option><option value="SUP-SOAP">SUP-SOAP · SOAP / XML</option></select></label><label>Identificador do lote<input value={batch} maxLength={150} onChange={e=>setBatch(e.target.value)} minLength={3} required/></label></div><div className="separator"/><div className="section-heading"><span className="step-num">02</span><div><h2>Produtos e destinos</h2><p>Um ou mais produtos do fornecedor seleccionado.</p></div></div>{lines.map((l,i)=><div key={i} className="order-line"><label>Produto / Centro<select value={l.key} required onChange={e=>setLines(x=>x.map((p,n)=>n===i?{...p,key:e.target.value}:p))}><option value="">Selecciona um produto</option>{eligible.map(s=><option value={`${s.region}|${s.product_id}`} key={`${s.region}${s.product_id}`}>{s.name} · {names[s.region]} (stock: {s.on_hand})</option>)}</select></label><label>Quantidade<input type="number" min="1" max="500" step="1" value={l.quantity} onChange={e=>setLines(x=>x.map((p,n)=>n===i?{...p,quantity:Number(e.target.value)}:p))}/></label><button className="btn ghost line-remove" type="button" disabled={lines.length===1} onClick={()=>setLines(x=>x.filter((_,n)=>n!==i))}>Remover</button></div>)}<button type="button" className="btn add-line" disabled={lines.length>=Math.min(15,eligible.length)} onClick={()=>{const s=eligible.find(a=>!lines.some(l=>l.key===`${a.region}|${a.product_id}`));if(s)setLines(x=>[...x,{key:`${s.region}|${s.product_id}`,quantity:1}]);else setFlash({type:'error',text:'Não existem mais produtos disponíveis para adicionar.'});}}>＋ Adicionar produto</button><div className="separator"/><div className="submit-bar"><div><strong>{lines.reduce((n,l)=>n+(Number.isFinite(l.quantity)?l.quantity:0),0)} unidades</strong><small>Fornecedor: {supplier}</small></div><button className="btn primary" disabled={busy||!eligible.length}>{busy?'A processar…':'Confirmar encomenda →'}</button></div></form></section><aside className="card help-card"><span className="help-icon">⌁</span><h2>Como é processada?</h2><ol><li>O comprador envia a ordem por HTTP.</li><li>O coordenador adquire um lock distribuído.</li><li>Os fragmentos regionais participam no 2PC.</li><li>O fornecedor REST/SOAP recebe o pedido.</li><li>A mercadoria é recepcionada quando chegar.</li></ol><div className="help-note">O mesmo identificador de lote não pode criar duas encomendas distintas para o mesmo fornecedor.</div></aside></div></>}
    {tab==='orders'&&<><PageTitle eyebrow="COMPRAS / ACOMPANHAMENTO" title="Encomendas" sub="Consulta o estado, descarrega facturas e acompanha os pedidos do teu centro."/><section className="card"><div className="toolbar"><input className="search-field" aria-label="Pesquisar encomendas" placeholder="Pesquisar lote, produto, fornecedor…" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Filtrar estado" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}><option value="all">Todos os estados</option><option value="CONFIRMED">Confirmada</option><option value="PENDING_SUPPLIER">Pendente</option><option value="SENDING">A enviar</option><option value="TX_COMMITTING">Em transacção</option></select></div><div className="table-wrap"><table><thead><tr><th>Encomenda</th><th>Fornecedor</th><th>Destinos</th><th>Estado</th><th>Data</th><th>Acções</th></tr></thead><tbody>{visibleOrders.map(o=><tr key={o.id}><td><b>{short(o.batch_id)}</b><small className="cell-sub">Criada por {o.created_by||'sistema'}</small></td><td><span className="mono">{o.supplier_id}</span></td><td>{o.items.filter(i=>isAdmin||i.region===user?.region).map(i=><div className="destination" key={`${i.region}${i.productId}`}>{names[i.region]} · {i.quantity} {i.productId}</div>)}</td><td><Status value={o.status}/>{o.last_error&&<small className="cell-sub error-text">{o.last_error}</small>}</td><td>{date(o.created_at)}</td><td><div className="inline-actions">{o.invoice_path&&<button className="btn small" onClick={()=>invoice(o)}>↓ Factura</button>}{o.status==='CONFIRMED'&&orderRegions(o).filter(r=>isAdmin||r===user?.region).map(r=><button key={r} className="btn small success" disabled={busy||received(o,r)} onClick={()=>receive(o,r)}>{received(o,r)?'✓ Recebida':`Receber · ${names[r].split(' · ')[0]}`}</button>)}</div></td></tr>)}{!visibleOrders.length&&<tr><td colSpan={6}><div className="empty">Não existem encomendas para estes filtros.</div></td></tr>}</tbody></table></div></section></>}
    {tab==='stock'&&<><PageTitle eyebrow="CENTROS / STOCK" title="Inventário regional" sub={isAdmin?'Consulta os stocks dos três armazéns.':'Consulta os produtos disponíveis no teu centro.'}/><section className="card"><div className="card-heading"><div><h2>Posições de stock</h2><p>Stock físico, reposição a caminho e parâmetros de segurança.</p></div>{isAdmin&&<button className="btn ghost" onClick={()=>setTab('catalogue')}>＋ Adicionar produto</button>}</div><div className="table-wrap"><table><thead><tr><th>Centro</th><th>Produto / SKU</th><th>Fornecedor</th><th>Em armazém</th><th>Em trânsito</th><th>Mínimo</th><th>Objectivo</th><th>Situação</th>{isAdmin&&<th>Demonstração</th>}</tr></thead><tbody>{stocks.map(s=><tr key={`${s.region}|${s.product_id}`}><td>{names[s.region]}</td><td><b>{s.name}</b><small className="cell-sub">{s.sku} · {s.product_id}</small></td><td className="mono">{s.supplier_id}</td><td><strong>{s.on_hand}</strong></td><td>{s.incoming_qty}</td><td>{s.minimum_stock}</td><td>{s.target_stock}</td><td>{s.on_hand+s.incoming_qty<=s.minimum_stock?<span className="tag amber">Stock baixo</span>:<span className="tag green">Normal</span>}</td>{isAdmin&&<td><button className="btn small" disabled={busy} onClick={()=>void act(async()=>{const n=Math.max(0,s.on_hand-12);await request(token,`/stocks/${s.region}/${s.product_id}/adjust`,{method:'POST',body:JSON.stringify({onHand:n})});return `Consumo simulado: ${s.name} em ${names[s.region]} agora tem ${n} unidades.`;})}>−12 unidades</button></td>}</tr>)}</tbody></table></div></section></>}
    {tab==='receipts'&&<><PageTitle eyebrow="ARMAZÉM / ENTRADAS" title="Recepção de mercadorias" sub="Confirma a chegada física das compras e actualiza o inventário regional."/><div className="tip"><b>Importante:</b> uma encomenda precisa estar confirmada pelo fornecedor. Cada item pode ser recepcionado uma única vez no respectivo centro.</div><section className="card"><div className="card-heading"><div><h2>Encomendas prontas para recepção</h2><p>A operação transfere quantidade de «Em trânsito» para «Em armazém».</p></div></div><div className="list-items">{orders.filter(o=>o.status==='CONFIRMED').flatMap(o=>orderRegions(o).filter(r=>isAdmin||r===user?.region).filter(r=>!received(o,r)).map(region=>({o,region}))).map(({o,region})=><div key={`${o.id}|${region}`} className="receipt-row"><div className="item-icon order">⇣</div><div className="grow"><strong>{short(o.batch_id)} · {names[region]}</strong><small>{o.items.filter(i=>i.region===region).map(i=>`${i.quantity} ${i.productId}`).join(' · ')}</small></div><button className="btn primary" disabled={busy} onClick={()=>receive(o,region)}>Confirmar recepção</button></div>)}{!orders.some(o=>o.status==='CONFIRMED'&&orderRegions(o).some(r=>(isAdmin||r===user?.region)&&!received(o,r)))&&<div className="empty">Não existem encomendas por receber.</div>}</div></section><section className="card"><div className="card-heading"><div><h2>Histórico de recepções</h2><p>Entradas registadas nos fragmentos regionais.</p></div><span className="tag neutral">{receipts.length} registos</span></div><div className="table-wrap"><table><thead><tr><th>Encomenda</th><th>Centro</th><th>Produto</th><th>Quantidade</th><th>Recepcionado por</th><th>Data</th></tr></thead><tbody>{receipts.map(r=><tr key={`${r.order_id}${r.region}${r.product_id}`}><td className="mono">{short(r.order_id)}</td><td>{names[r.region]}</td><td>{r.product_id}</td><td><b>+{r.quantity}</b></td><td>{r.received_by}</td><td>{date(r.received_at)}</td></tr>)}{!receipts.length&&<tr><td colSpan={6}><div className="empty">Ainda não existem recepções.</div></td></tr>}</tbody></table></div></section></>}
    {tab==='catalogue'&&isAdmin&&<><PageTitle eyebrow="ADMINISTRAÇÃO / CATÁLOGO" title="Adicionar produto" sub="Insere um produto no fragmento PostgreSQL de um centro regional."/><section className="card padded narrow"><form onSubmit={e=>{e.preventDefault();void act(async()=>{await request(token,'/products',{method:'POST',body:JSON.stringify(newProduct)});setNewProduct({...newProduct,productId:'',sku:'',name:''});return 'Produto criado com sucesso.';});}} className="form-stack"><div className="form-grid"><label>Centro<select value={newProduct.region} onChange={e=>setNewProduct({...newProduct,region:e.target.value as Region})}>{(Object.keys(names) as Region[]).map(r=><option key={r} value={r}>{names[r]}</option>)}</select></label><label>Fornecedor<select value={newProduct.supplierId} onChange={e=>setNewProduct({...newProduct,supplierId:e.target.value as Supplier})}><option value="SUP-REST">SUP-REST</option><option value="SUP-SOAP">SUP-SOAP</option></select></label><label>ID do produto<input required minLength={2} value={newProduct.productId} onChange={e=>setNewProduct({...newProduct,productId:e.target.value})} placeholder="FEIJAO1KG"/></label><label>SKU<input required value={newProduct.sku} onChange={e=>setNewProduct({...newProduct,sku:e.target.value})} placeholder="FEI-001"/></label></div><label>Nome do produto<input required minLength={3} value={newProduct.name} onChange={e=>setNewProduct({...newProduct,name:e.target.value})} placeholder="Feijão 1 kg"/></label><div className="form-grid thirds"><label>Quantidade actual<input type="number" min={0} value={newProduct.onHand} onChange={e=>setNewProduct({...newProduct,onHand:Number(e.target.value)})}/></label><label>Stock mínimo<input type="number" min={0} value={newProduct.minimumStock} onChange={e=>setNewProduct({...newProduct,minimumStock:Number(e.target.value)})}/></label><label>Stock objectivo<input type="number" min={1} value={newProduct.targetStock} onChange={e=>setNewProduct({...newProduct,targetStock:Number(e.target.value)})}/></label></div><button className="btn primary" disabled={busy}>Guardar produto →</button></form><p className="subtle-note">Só o administrador pode adicionar produtos. Para a mesma referência existir noutro centro, cria um registo específico desse centro.</p></section></>}
    {tab==='infrastructure'&&isAdmin&&<><PageTitle eyebrow="SISTEMA / MONITORIZAÇÃO" title="Infraestrutura distribuída" sub="Monitorização dos primários, réplicas e registos de auditoria."/><div className="node-grid">{nodes.map(n=><div className="card node-card" key={n.region}><span className="node-symbol">◉</span><div className="kicker">POSTGRESQL · {n.region.toUpperCase()}</div><h2>{names[n.region]}</h2><div className="node-facts"><span><b>{n.streaming_replicas}</b> réplicas em streaming</span><span><b>{n.prepared_transactions}</b> transacções preparadas</span></div><span className={`tag ${n.streaming_replicas?'green':'amber'}`}>{n.streaming_replicas?'Replicação activa':'Verificar réplica'}</span></div>)}</div><section className="card"><div className="card-heading"><div><h2>Auditoria do coordenador</h2><p>Eventos recentes registados na base de dados Norte.</p></div><button className="btn ghost" disabled={busy} onClick={()=>void act(async()=>{const r=await request<Array<{batchId:string}>>(token,'/monitor/run',{method:'POST'});return `Verificação concluída: ${r.length} lote(s) analisado(s).`;})}>↻ Verificar reposição</button></div><div className="table-wrap"><table><thead><tr><th>Evento</th><th>Encomenda</th><th>Data</th></tr></thead><tbody>{audit.map(a=><tr key={a.id}><td><b>{a.event_type}</b></td><td className="mono">{a.order_id?short(a.order_id):'Sistema'}</td><td>{date(a.occurred_at)}</td></tr>)}{!audit.length&&<tr><td colSpan={3}><div className="empty">Sem eventos.</div></td></tr>}</tbody></table></div></section></>}
    </div><footer className="footer">SCAD Coordena · MVP académico · ISUTC · 2026 <span>Dados e fornecedores simulados · Não utilizar para compras reais</span></footer>
  </main></div>;
}
function Metric({title,value,extra,icon,warning=false}:{title:string;value:string;extra:string;icon:string;warning?:boolean}){return <div className="metric"><div className="metric-top"><span>{title}</span><span className={`metric-icon ${warning?'warning':''}`}>{icon}</span></div><div className="metric-value">{value}</div><small>{extra}</small></div>;}
function Status({value}:{value:string}){return <span className={`tag ${value==='CONFIRMED'?'green':value==='PENDING_SUPPLIER'?'amber':'neutral'}`}>{statusLabel[value]||value}</span>;}
function PageTitle({eyebrow,title,sub}:{eyebrow:string;title:string;sub:string}){return <div className="page-lead"><div><div className="kicker">{eyebrow}</div><h1>{title}</h1><p>{sub}</p></div></div>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
