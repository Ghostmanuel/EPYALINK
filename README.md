# EPYALINK 3.1

Versão consolidada e responsiva do EPYALINK para demonstração/deploy no Render.

## Incluído
- Menu mobile: Início, Mercado, Pedidos, Transporte, Chat e Perfil.
- Botão Sair no cabeçalho e no Perfil, com confirmação.
- Cadastro com comprador, produtor/vendedor, fornecedor de insumos, transportador e transportadora.
- Mercado de produção agrícola e insumos: sementes, fertilizantes, adubos, irrigação, ferramentas, máquinas e equipamentos.
- Foto de perfil sincronizada no perfil, mercado, pedidos e chat.
- Publicação de produto com fotografia.
- Estoque decrementado após pedido.
- Cotação com peso + distância + transporte + serviço EPYALINK + total.
- Transporte EPYALINK com parceiros, solicitação, aceitação, início e confirmação por PIN.
- Pagamentos pendentes e aprovação administrativa.
- Liquidação após entrega confirmada.
- Avaliações, favoritos, notificações e disputas.
- Painel administrativo com dashboard, utilizadores, produtos, pedidos, pagamentos, relatórios, auditoria, disputas e tarifas.
- Cálculo rodoviário tenta usar geocodificação/roteamento e tem fallback para corredores conhecidos.

## Render
Build: `pip install -r requirements.txt`

Start: `uvicorn app:app --host 0.0.0.0 --port $PORT`

Health: `/health`

Configure no Render: `SECRET_KEY`, `ADMIN_PHONE` e `ADMIN_PASSWORD`.

A conta administrativa de demonstração, quando as variáveis não são definidas, usa `999999999` / `Admin@12345`; altere isso antes de qualquer utilização real.

## Importante
O pagamento desta versão é um fluxo de demonstração/validação administrativa. Para produção, ligar a um PSP/EMI aprovado e implementar as regras contratuais, fiscais, de transporte, seguros e proteção de dados aplicáveis.

O SQLite é adequado para demonstração. Para produção no Render, migrar para PostgreSQL ou outro armazenamento persistente e configurar armazenamento de ficheiros apropriado.
