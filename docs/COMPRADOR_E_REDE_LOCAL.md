# Portal de compradores regionais (v0.2)

**Esta versão tem autenticação com tokens e autorização por região na API.** O posto do comprador deixou de ser um mero formulário aberto.

## Arquitectura de acesso

```text
Computador A (Docker)                    Computadores B, C e D (navegador)
  :8080 / Nginx / React       <--------- Comprador Sul
    |                                   Comprador Centro
    +--> :3000 API                       Comprador Norte
           |
           +--> PostgreSQL Sul/Centro/Norte e réplicas
           +--> etcd 3 membros
           +--> fornecedor REST/SOAP simulado
```

Cada computador remoto acede a `http://IP_DO_SERVIDOR:8080`. Só o servidor precisa de Docker; nos outros basta navegador ou Postman.

## Perfil e permissões

- Comprador Sul: vê e compra apenas para Maputo.
- Comprador Centro: vê e compra apenas para Beira.
- Comprador Norte: vê e compra apenas para Nampula.
- Administrador: pode operar nos três centros, consultar o cluster, simular consumo, criar produtos e forçar a monitorização.

A região do comprador é codificada no token autenticado pelo servidor e não pode ser alterada através de parâmetros JSON.

## Fluxo do comprador

1. Iniciar sessão com o utilizador do respectivo centro.
2. Consultar indicadores e inventário do centro.
3. Abrir **Nova encomenda**, seleccionar fornecedor, produto e quantidade.
4. Confirmar e acompanhar em **Encomendas**.
5. Quando o fornecedor confirmar, descarregar factura e abrir **Recepções**.
6. Clicar **Confirmar recepção**; o stock físico aumenta e a quantidade em trânsito diminui.
7. Consultar **Histórico de recepções**.

O comprador não recebe acesso ao cluster nem pode adicionar produtos ou simular consumo.

## Segurança e limitações

- Alterar as credenciais e as chaves do ficheiro `.env` antes de permitir ligação a outros computadores.
- Utilizar apenas rede privada de laboratório; este protótipo não configura HTTPS, gestão de sessões revogáveis, rate limiting nem política de palavras-passe de produção.
- O sistema não implementa ainda recepções parciais ou cancelamento/compensação de compras.
- As facturas de ordens multirregionais são facturas partilhadas do fornecedor e podem incluir outros centros; evitar dados reais ou sensíveis nesta demonstração.

Consulta [`COMANDOS_OPERACAO.md`](COMANDOS_OPERACAO.md) para os comandos completos e exemplos Postman.
