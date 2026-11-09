# SCAD Coordena Regional — Comandos de operação e apresentação

Este ficheiro é o **roteiro operacional** da v0.2. Os exemplos usam `http://localhost:8080` na máquina do servidor; **no computador do comprador**, substitui `localhost` pelo endereço IPv4 LAN do servidor.

## 1. Arranque no computador servidor

```bash
cd scad-coordena-mvp-regional
cp .env.example .env
# Edita .env e substitui TODAS as palavras-passe e segredos de demonstração.
# Para gerar uma chave: openssl rand -hex 32

docker compose config --quiet
docker compose up --build -d
docker compose ps
curl http://localhost:8080/api/health
```

Para ver logs:

```bash
docker compose logs --tail=100 api
docker compose logs -f api agent-south agent-center agent-north
```

Para verificar a replicação:

```bash
bash scripts/check-replication.sh
docker compose exec pg-south psql -U scad -d scad -c 'SELECT application_name, state FROM pg_stat_replication;'
docker compose exec pg-south-replica psql -U scad -d scad -c 'SELECT pg_is_in_recovery();'
```

## 2. Aceder pela rede LAN

No servidor Linux:

```bash
hostname -I
ip -4 addr show
```

No servidor Windows:

```powershell
ipconfig
```

Em cada computador comprador, abrir no navegador:

```text
http://IP_REAL_DO_SERVIDOR:8080
```

No servidor, a porta externa é **8080**. A API na porta 3000 está publicada apenas no loopback do host. Se a rede usar isolamento de clientes, a ligação poderá falhar. Nunca abrir esta porta à Internet.

## 3. Contas regionais

Valores predefinidos do ficheiro `.env.example` (trocar antes de usar na LAN):

| Login | Centro | Palavra-passe de exemplo |
|---|---|---|
| `buyer-south` | Maputo | `SulDemo2026!` |
| `buyer-center` | Beira | `CentroDemo2026!` |
| `buyer-north` | Nampula | `NorteDemo2026!` |
| `admin` | Todos | `AdminDemo2026!` |

O login disponibiliza um token de sessão de 8 horas. Para trabalhar com Postman ou REST Client, escolhe o tipo de autenticação **Bearer Token** e cola o token obtido no login.

## 4. Login e criar encomenda via cURL

Substitui o endereço, utilizador e palavra-passe. No Linux, com `jq`:

```bash
BASE_URL='http://localhost:8080'
TOKEN=$(curl -fsS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"buyer-south","password":"SulDemo2026!"}' | jq -r '.data.token')

curl -fsS "$BASE_URL/api/auth/me" -H "Authorization: Bearer $TOKEN" | jq
curl -fsS "$BASE_URL/api/stocks" -H "Authorization: Bearer $TOKEN" | jq

curl -fsS -X POST "$BASE_URL/api/purchases" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"supplierId":"SUP-REST","batchId":"LAB-SUL-001","items":[{"region":"south","productId":"RICE25","quantity":8}]}' | jq
```

**Trocar o `batchId`** para uma nova encomenda. Reenviar o mesmo fornecedor/lote/itens é idempotente.

Consultar encomendas:

```bash
curl -fsS "$BASE_URL/api/purchases" -H "Authorization: Bearer $TOKEN" | jq
```

Quando estiver `CONFIRMED`, registar a recepção:

```bash
ORDER_ID='<UUID_DA_ENCOMENDA>'
curl -fsS -X POST "$BASE_URL/api/purchases/$ORDER_ID/receive" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"region":"south"}' | jq
```

Confirmar o registo:

```bash
curl -fsS "$BASE_URL/api/receipts" -H "Authorization: Bearer $TOKEN" | jq
curl -fsS "$BASE_URL/api/stocks" -H "Authorization: Bearer $TOKEN" | jq
```

A primeira recepção transfere as unidades de `incoming_qty` para `on_hand`. A segunda, com a mesma ordem/região, indica `alreadyReceived:true`, sem duplicar o stock.

## 5. Demonstração de autorização regional

No Postman, com o token de `buyer-south`, envia um pedido destinado ao Centro:

```http
POST /api/purchases HTTP/1.1
Content-Type: application/json
Authorization: Bearer <TOKEN_DO_COMPRADOR_SUL>

{"supplierId":"SUP-REST","batchId":"TESTE-NAO-AUTORIZADO","items":[{"region":"center","productId":"RICE25","quantity":1}]}
```

**Resultado esperado:** HTTP `403`, sem criar a encomenda. O mesmo comprador pode criar ordens para a região `south`.

## 6. Demonstração de administrador

Inicia sessão `admin` na interface. Testa a criação de uma ordem que envolve Sul e Centro e observa o processo de 2PC. Utiliza o menu **Adicionar produto** para criar um artigo no inventário regional.

O administrador também pode executar a reposição automática, ver réplicas e auditar eventos.

## 7. Scripts de apresentação

```bash
bash scripts/demo.sh
bash scripts/test-e2e.sh
```

O script `test-e2e.sh` cria compras de laboratório e altera stocks; executar num ambiente apropriado. Testa permissões, concorrência, 2PC e idempotência de recepção.

## 8. Parar e limpar

```bash
# Parar, mantendo dados dos volumes
docker compose down

# Relançar
docker compose up -d

# APENAS em ambiente descartável: elimina TODOS os dados
docker compose down -v
```

## 9. Problemas comuns

- `401`: falta Bearer Token, credenciais inválidas ou sessão expirada.
- `403`: tentativa do comprador de aceder a outro centro ou a funções administrativas.
- `409`: recepção antes de confirmação, stock inconsistente ou conflito de lote.
- `502` em `/api`: o proxy Nginx não está a alcançar a API; verificar `docker compose logs web api`.
- Sem acesso remoto: verificar IP LAN correcto, firewall TCP 8080 e isolamento da Wi-Fi.
- Sem réplicas: consultar logs `pg-*-replica` e `scripts/check-replication.sh`.
