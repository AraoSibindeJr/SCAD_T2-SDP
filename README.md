# SCAD Coordena — MVP Regional v0.2

**Sistema de Compras Automáticas Distribuídas**  
ISUTC · Sistemas Distribuídos e Paralelos · 2026

Este pacote é uma **evolução do MVP anterior**, com um portal de compradores por centro regional, autenticação de laboratório, autorização no backend, criação de encomendas, histórico, facturas, recepção de mercadorias, registo de produtos e monitorização para administração.

> **Âmbito:** protótipo de demonstração com fornecedores simulados. Não é aplicação pronta para produção. Ainda faltam DFS real, failover automático seguro, NTP em hosts independentes, implementação Java/CORBA e testes completos de falha durante o 2PC. Os serviços estão distribuídos por containers no mesmo host, salvo se a infra for implantada de outra maneira.

## Aceder e arrancar

Necessitas de Docker Engine ou Docker Desktop, Docker Compose v2 e memória disponível (recomenda-se **8 GB livres** para o conjunto de 15 containers). Para os scripts de teste: Bash, `curl`, `jq` e Docker CLI.

```bash
cp .env.example .env
# ALTERAR as senhas e as chaves do ficheiro .env
# Podes gerar segredos aleatórios com: openssl rand -hex 32

docker compose config --quiet
docker compose up --build -d
docker compose ps
curl http://localhost:8080/api/health
```

Acede a **http://localhost:8080** no servidor ou a **http://IP_DO_SERVIDOR:8080** noutro computador da LAN. O frontend e a API utilizam a mesma origem, com Nginx a fazer proxy de `/api` para o serviço Node.

A porta 3000 fica limitada a `127.0.0.1` do servidor; os compradores remotos utilizam só a 8080. A configuração `.env` permite restringir `SCAD_BIND_ADDRESS` ao IPv4 LAN exacto do servidor.

### Contas predefinidas para laboratório

| Utilizador | Papel | Centro | Palavra-passe predefinida em `.env.example` |
|---|---|---|---|
| `admin` | Administrador | Todos | `AdminDemo2026!` |
| `buyer-south` | Comprador | Maputo / Sul | `SulDemo2026!` |
| `buyer-center` | Comprador | Beira / Centro | `CentroDemo2026!` |
| `buyer-north` | Comprador | Nampula / Norte | `NorteDemo2026!` |

**Trocar as palavras-passe e chaves antes de abrir o serviço à LAN.** As credenciais são simples variáveis de ambiente para demonstração. Os tokens são assinados e expiram após 8 horas, mas não há TLS, revogação de sessões, rate limiting nem gestão persistente de utilizadores.

## Funcionalidades

| Área | Administrador | Comprador regional |
|---|---|---|
| Autenticar com token | Sim | Sim |
| Consultar inventário | 3 centros | Apenas seu centro |
| Criar encomendas | Um ou vários centros | Apenas seu centro |
| Consultar encomendas | Todas | Com itens do seu centro |
| Descarregar facturas | Sim | Das encomendas visíveis |
| Receber mercadorias confirmadas | Qualquer centro | Apenas seu centro |
| Consultar histórico de recepções | Todas as regiões | Apenas sua região |
| Simular consumo e adicionar produtos | Sim | Não |
| Monitorizar cluster e auditoria | Sim | Não |
| Reposição automática dos agentes | Execução em background | Acompanhamento dos efeitos |

### Modelo de stock

- `on_hand`: quantidade física disponível;
- `incoming_qty`: mercadoria comprada, mas ainda não recepcionada;
- `minimum_stock`: limiar para disparar reposição;
- `target_stock`: objectivo usado na reposição automática.

**Fluxo:** compra criada → `incoming_qty` aumenta via 2PC → fornecedor confirma → comprador regista recepção → `incoming_qty` diminui e `on_hand` aumenta no fragmento local. Cada recepção é idempotente por `(order_id, product_id)` em cada fragmento regional.

### Operação pela rede

O Computador A executa Docker; os Computadores B, C e D utilizam os navegadores para iniciar sessão nos respectivos centros. O login altera os dados visíveis e os endpoints autorizados. Não basta editar `region` no JSON: a API devolve HTTP **403** se um comprador tentar operar sobre outro centro.

Um comprador também pode usar Postman ou REST Client, passando `Authorization: Bearer <TOKEN>` recebido no login. Consulta os exemplos em [`docs/COMANDOS_OPERACAO.md`](docs/COMANDOS_OPERACAO.md), [`docs/COMPRADOR_E_REDE_LOCAL.md`](docs/COMPRADOR_E_REDE_LOCAL.md), no [`examples/SCAD_Comprador.http`](examples/SCAD_Comprador.http) e na [colecção Postman](examples/SCAD_Postman_Collection.json).

## API principal

| Método | Endpoint | Acesso |
|---|---|---|
| `GET` | `/api/health` | Público |
| `POST` | `/api/auth/login` | Público |
| `GET` | `/api/auth/me` | Autenticado |
| `GET` | `/api/stocks` | Autenticado; filtragem regional |
| `POST` | `/api/purchases` | Autenticado; validação regional |
| `GET` | `/api/purchases` | Autenticado; filtragem regional |
| `GET` | `/api/purchases/:id` | Autenticado; visibilidade regional |
| `GET` | `/api/purchases/:id/invoice` | Autenticado; visibilidade regional |
| `GET` | `/api/receipts` | Autenticado; filtragem regional |
| `POST` | `/api/purchases/:id/receive` | Autenticado; região autorizada |
| `POST` | `/api/products` | Administrador |
| `POST` | `/api/stocks/:region/:productId/adjust` | Administrador |
| `POST` | `/api/monitor/run` | Administrador |
| `GET` | `/api/cluster` | Administrador |
| `GET` | `/api/audit` | Administrador |
| `POST` | `/api/alerts` | Apenas agentes internos com segredo partilhado |

### Exemplo rápido com Postman ou cURL

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"buyer-south","password":"<A_SUA_PALAVRA_PASSE>"}'
```

Copia `.data.token` da resposta e usa-o como Bearer Token:

```bash
curl -X POST http://localhost:8080/api/purchases \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -d '{"supplierId":"SUP-REST","batchId":"SUL-DEMO-001","items":[{"region":"south","productId":"RICE25","quantity":10}]}'
```

A ordem passa por `TX_COMMITTING` → `PENDING_SUPPLIER` → `SENDING` → `CONFIRMED`. O fornecedor pode devolver uma factura PDF. Depois da confirmação, o comprador utiliza a interface de **Recepções** ou `POST /api/purchases/:id/receive`.

## Scripts e demonstrações

```bash
./scripts/check-replication.sh
./scripts/demo.sh
./scripts/test-e2e.sh
```

O script de testes verifica autenticação, restrições regionais, replicação, concorrência/idempotência, transacções preparadas, REST/SOAP e recepção sem duplicação. **Os testes ainda precisam de ser executados num host Docker do grupo; não foram corridos neste ambiente de autoria.**

## Estrutura

```text
scad-coordena-mvp-regional/
├── apps/
│   ├── api/src/         # HTTP, autenticação, 2PC, agentes, compras, recibos
│   ├── web/src/         # Portal React com formulário por perfil
│   └── supplier-mock/   # Fornecedores REST e SOAP simulados
├── infra/postgres/      # Fragmentos, réplicas, init e schema
├── scripts/             # Verificação, testes e demo
├── docs/
│   ├── COMANDOS_OPERACAO.md
│   ├── COMPRADOR_E_REDE_LOCAL.md
│   ├── ARQUITETURA.md
│   └── DEMONSTRACAO.md
├── compose.yaml
└── .env.example
```

## Notas de migração da v0.1

A API aplica automaticamente duas mudanças aditivas nos primários existentes: cria a tabela `stock_receipts` em cada região e adiciona `created_by` e `origin_region` ao catálogo de encomendas do Norte. **Não é necessário executar `docker compose down -v`**, que apagaria os dados. Por precaução, guarda uma cópia dos volumes antes de actualizar dados que pretendas conservar.

## Limitações técnicas

- Registo de recepção usa **transacção local** no shard regional; o evento no catálogo de auditoria é gravado depois. Não existe atomicidade entre esse evento e a recepção se houver falha de rede, e uma rotina de reconciliação ainda está pendente.
- O 2PC protege a criação das compras multirregionais, não a chamada HTTP ao fornecedor.
- A autenticação é adequada apenas para um laboratório numa LAN confiável; não há HTTPS nem gestão de sessões pronta para produção.
- Não existe recepção parcial, cancelamento/compensação de encomendas, DFS de três nós, failover automático ou integração Java/CORBA real.
- Os algoritmos existentes continuam sujeitos às limitações da v0.1 (incluindo fencing incompleto).

## Referências técnicas

- PostgreSQL 16: https://www.postgresql.org/docs/16/sql-prepare-transaction.html
- Replicação PostgreSQL: https://www.postgresql.org/docs/16/warm-standby.html
- Docker Compose: https://docs.docker.com/compose/
- etcd: https://etcd.io/docs/
