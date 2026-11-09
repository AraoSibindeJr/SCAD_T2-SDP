# Alterações implementadas — v0.2

## Componentes adicionados

- `apps/api/src/auth.ts`: contas de laboratório, login, tokens assinados, verificação de permissões, autorização por centro e segredo interno dos agentes.
- `apps/api/src/migrations.ts`: upgrade aditivo de bases existentes para a v0.2.
- `apps/web/src/main.tsx`: login; portal central e regional; formulário de encomendas; histórico; facturas; recepções; catálogo; cluster e auditoria.
- `infra/postgres/schema.sql`: metadados da origem das ordens e `stock_receipts` por região.
- `scripts/test-e2e.sh`: teste de login, isolamento regional, concorrência, replicação, comunicação com fornecedores e recepção idempotente.

## Coerência distribuída

A criação das encomendas conserva o 2PC de compras existente. O novo workflow de recepção usa uma única transacção ACID **em cada fragmento regional**. A auditoria, no PostgreSQL Norte, é escrita depois do commit local; se essa escrita falhar, a recepção permanece válida e requer reconciliação posterior dos registos de auditoria.

## Segurança do MVP

Há controlo de acesso pelo servidor, mas não é uma solução de segurança de produção. Os utilizadores são configurados no `.env`, não em base de dados, e os tokens são assinados pelo segredo `SCAD_AUTH_SECRET`. Os agentes utilizam uma chave interna própria para enviar alertas.

## Não incluído nesta versão

DFS real, CORBA, NTP entre hosts, failover automático seguro, recepção parcial, cancelamento de ordens, inventário multi-produto complexo, autenticação multi-factor e sessões revogáveis.
