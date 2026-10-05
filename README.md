# EPYALINK

"O Alibaba do Agro Angolano" — plataforma B2B que liga zonas de produção
agrícola (Huambo, Malanje, Cuanza Sul...) a grandes compradores, indústrias e
supermercados noutras províncias, com um serviço opcional de retalho urbano
(fracionado em kg, entrega porta a porta). Desenvolvido pela empresa mãe
**Nuvem JV — Prestação de Serviços & Tecnologias, Limitada** (NIF: 5003447952).

Backend em **Node.js + Express + PostgreSQL**. Frontend em HTML/CSS/JS puro
(sem build step), servido pelo próprio Express. Tudo funcional e ligado a uma
base de dados real — **exceto o pagamento por Multicaixa Express/IBAN**, que
por agora fica em custódia e é confirmado manualmente (ver "Pagamentos"
abaixo), porque exige contrato direto com um banco angolano.

## O que está implementado

- **Cinco papéis**: comprador (loja/indústria), produtor, transportadora
  interprovincial, estafeta urbano, Ponto EPYALINK (agente rural), e administrador
- Registo e login com password encriptada (bcrypt) e sessão por JWT
- **Recuperação de password por SMS** via [KambaSMS](https://www.kambasms.ao) (OTP gerido), com opção por WhatsApp (Meta Cloud API)
- **Dois segmentos de pedido**:
  - **B2B interprovincial** (core business): lote mínimo por produto, três formas de entrega (recolha, vendedor entrega, transportadora interprovincial), taxa de plataforma (take rate) de 3%
  - **Retalho urbano** (opcional): fracionamento em kg (1–50 kg), zonas da cidade, entrega por estafeta local com tarifa calculada pela distância
- **Custódia (escrow)**: o valor fica retido desde o pagamento até à entrega ser validada
- **Confirmação de entrega por PIN via SMS**: ao chegar à fase final do percurso, um PIN de 6 dígitos é enviado ao telemóvel do comprador; só com o PIN certo o transportador/vendedor consegue marcar a entrega como concluída — e é isso que liberta a custódia, automaticamente, para produtor, transportadora e Ponto EPYALINK
- **Rastreamento GPS em tempo real**: o transportador partilha a localização (`navigator.geolocation`) enquanto a carga viaja; deteção automática da fase final ativa o envio do PIN; pontos de passagem por Hubs regionais ficam registados
- **Carteira móvel**: saldo por utilizador (livro-razão), levantamento (Cash-Out) confirmado por código enviado por SMS
- Perfis com reputação: avaliações, vendas concluídas, selo de verificado ✓
- Produtos com estoque em tempo real (desce a cada venda, fica "esgotado" a zero)
- Pesquisa com filtros: produto, província, preço, unidade, tipo de vendedor, disponibilidade
- Chat ligado ao produto/pedido, favoritos, notificações
- Centro de disputas com decisão do administrador (reembolsar / libertar custódia / pedir mais evidências)
- Painel do produtor, perfil da fazenda, frota da transportadora, painel do Ponto EPYALINK, rede logística (Hubs) geridos pelo administrador, inteligência de mercado (calculada a partir de pedidos e pesquisas reais)

## Modelo de comissões (implementado no livro-razão)

| Taxa | Valor | Quem paga | Quando |
|---|---|---|---|
| Take rate B2B | 3% | Comprador | Adicionada ao total do pedido B2B |
| Custódia & PIN SMS | ~1,5% | Vendedor | Descontada na libertação da custódia |
| Comissão do Ponto EPYALINK | 4% | Plataforma → Ponto | Paga ao Ponto quando valida a recolha |
| Comissão de transporte interprovincial | 8% | Transportadora | Descontada no pagamento do frete |
| Comissão de estafeta urbano | 10% | Estafeta | Descontada no pagamento da entrega |
| Margem de fracionamento (retalho) | 10% | Vendedor | Só em pedidos de retalho urbano |
| Taxa de levantamento (carteira) | ~1,5% | Quem levanta | Só no Cash-Out |

Todos os valores estão em `src/lib/business.js` — ajusta as constantes conforme
o modelo de negócio evoluir.

## Estrutura do projeto

```
src/
  server.js          servidor Express, aplica o esquema SQL automaticamente no arranque
  db.js              ligação PostgreSQL
  lib/
    jwt.js           assinar/verificar sessões
    sms.js           KambaSMS (SMS/OTP) + WhatsApp (Meta Cloud API)
    business.js      distâncias, taxas, zonas urbanas, geração de PIN
    finance.js       custódia (escrow), livro-razão, envio do PIN por SMS
  middleware/auth.js  autenticação e permissões por papel
  routes/            um ficheiro por área (auth, products, orders, carrier, agent, wallet, admin, ...)
db/schema.sql        esquema completo da base de dados (aplicado automaticamente, migrações idempotentes)
public/              frontend (index.html, ficheiro único)
scripts/seed.js      cria contas e dados de demonstração
```

## Publicar no Render

1. Sobe este projeto para um repositório no GitHub.
2. No Render → **New +** → **Blueprint**, aponta para o repositório. O ficheiro
   `render.yaml` cria automaticamente o Web Service e a base de dados PostgreSQL,
   e liga-os (`DATABASE_URL` é preenchido sozinho).
3. Em **Environment**, define pelo menos:
   - `KAMBASMS_API_KEY` — a tua chave em https://www.kambasms.ao/dashboard/keys
   - (opcional) `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_ID` — se quiseres oferecer recuperação/PIN por WhatsApp

   Sem `KAMBASMS_API_KEY` definida, tudo o que depende de SMS (recuperação de
   password, PIN de entrega, código de levantamento) continua a funcionar em
   **modo de teste**: o código é devolvido na resposta da API (`devHint` /
   `devCode` / `pin`) e escrito no log do servidor, nunca enviado por SMS real.
4. Depois do primeiro deploy, corre a criação de dados de demonstração uma vez,
   no **Shell** do serviço no Render:
   ```
   npm run seed
   ```
   Isto cria contas (password `epyalink123` para todas):
   | Papel                  | Telefone         |
   |------------------------|------------------|
   | Produtor               | +244923000001    |
   | Comprador               | +244923000002    |
   | Comprador corporativo  | +244923000006    |
   | Transportadora (interprov.) | +244923000003 |
   | Estafeta urbano        | +244923000005    |
   | Ponto EPYALINK         | +244923000007    |
   | Administrador          | +244923000004    |

   Não há registo público de administrador (por segurança) — a única forma de
   criar um é através do `scripts/seed.js` ou diretamente na base de dados.

## Correr localmente

```
cp .env.example .env        # preenche DATABASE_URL com um PostgreSQL local
npm install
npm run seed                 # opcional: cria as contas de demonstração
npm run dev
```
Abre http://localhost:3000 — o esquema da base de dados é criado/atualizado
automaticamente no arranque (não precisas de correr migrações à parte).

## Sobre o KambaSMS e o PIN de entrega

O serviço de OTP da KambaSMS ([documentação](https://www.kambasms.ao/dashboard/docs))
envia e valida códigos do lado deles. Para o **PIN de entrega**, usamos o envio
de SMS transacional simples da KambaSMS (`src/lib/sms.js` → `sendTransactional`),
porque o PIN é gerado e verificado no nosso próprio servidor (fica ligado ao
pedido, com número máximo de tentativas e reenvio). **Confirma o endereço
exato do endpoint e o nome do cabeçalho de autenticação no dashboard antes de
ires para produção** — o código foi escrito com base na documentação pública
disponível à data desta integração.

A KambaSMS não oferece canal WhatsApp. Para esse canal, `src/lib/sms.js` já
está pronto para a **Meta WhatsApp Cloud API** (precisa de um template de
mensagem aprovado pela Meta) — basta preencheres `WHATSAPP_TOKEN` e
`WHATSAPP_PHONE_ID`.

## Sobre os pagamentos

O EPYALINK retém o valor do pedido em custódia (produto + transporte + taxa de
plataforma) desde o pagamento até o PIN de entrega ser validado — isso já está
todo implementado e funcional, com libertação automática para produtor,
transportadora e Ponto EPYALINK, registada no livro-razão (`ledger_entries`).
O que **não está automatizado** é a cobrança real por Multicaixa Express ou
transferência IBAN, porque isso exige um contrato com um banco ou processador
de pagamentos angolano (ex.: EMIS/Multicaixa). Por agora, o comprador escolhe
a forma de pagamento e o EPYALINK regista a confirmação manualmente (é o que o
botão "Pagar" no ecrã de pagamento faz). Quando esse contrato existir, basta
substituir esse passo por uma chamada real à API do processador escolhido — o
resto do ciclo (custódia, PIN, libertação, comissões, disputas) mantém-se
igual.

## Publicar na App Store e na Play Store

O EPYALINK já vem com um projeto [Capacitor](https://capacitorjs.com) pronto,
que embrulha o mesmo site numa app nativa real — com acesso a GPS, câmara e
splash screen — gerando os projetos nativos para Android (`android/`) e iOS
(`ios/`). **Não precisas de reescrever nada**: a app carrega o teu site já
publicado no Render, por isso qualquer atualização ao site aparece na app na
hora, sem nova submissão às lojas.

### Antes de tudo: aponta a app para o teu site publicado

Edita `capacitor.config.ts` e substitui o endereço de exemplo pelo teu domínio
real do Render:
```ts
server: {
  url: 'https://epyalink.onrender.com',   // ← o teu endereço real aqui
  cleartext: false
}
```
Depois corre `npm run cap:sync` para aplicar a alteração aos dois projetos.

### Ícone e splash screen

Já estão gerados a partir de `resources/icon.png` e `resources/splash.png`
(verde EPYALINK com o símbolo da marca). Se quiseres mudar o desenho, substitui
esses dois ficheiros e corre `npm run cap:assets` — gera automaticamente todos
os tamanhos exigidos pelas duas lojas.

### Publicar no Android (Play Store)

1. Precisas do [Android Studio](https://developer.android.com/studio) instalado (Windows, Mac ou Linux — ao contrário do iOS, não precisa de Mac).
2. Corre `npm run cap:android` — abre o projeto `android/` no Android Studio.
3. Em **Build → Generate Signed Bundle / APK**, escolhe **Android App Bundle**, cria uma chave de assinatura (guarda-a bem — vais precisar dela em todas as atualizações futuras) e gera o ficheiro `.aab`.
4. Cria uma conta em [Google Play Console](https://play.google.com/console) (25 USD, pagamento único).
5. Cria uma nova app, preenche a ficha da loja (ícone, capturas de ecrã, descrição, política de privacidade) e submete o `.aab` gerado.
6. A revisão da Google demora normalmente 1 a 3 dias.

### Publicar no iOS (App Store)

**Precisas de um Mac** com [Xcode](https://apps.apple.com/app/xcode/id497799835) instalado — é exigência da própria Apple, não há volta a dar.

1. Corre `npm run cap:ios` — abre o projeto `ios/App/App.xcworkspace` no Xcode.
2. Em **Signing & Capabilities**, seleciona a tua equipa de programador (precisas de ter uma conta [Apple Developer Program](https://developer.apple.com/programs/), 99 USD/ano).
3. Em **Product → Archive**, gera o arquivo da app.
4. No **Organizer** que abre a seguir, clica em **Distribute App → App Store Connect** para submeter.
5. Em [App Store Connect](https://appstoreconnect.apple.com), preenche a ficha da loja e envia para revisão.
6. A revisão da Apple costuma demorar 1 a 2 semanas e é mais rigorosa — está atento a pedidos de esclarecimento sobre os pagamentos simulados e a recolha de localização (as descrições que já preenchemos em `Info.plist` ajudam, mas pode ser preciso responder a perguntas do revisor).

### Permissões já configuradas

| Permissão | Porquê | Onde |
|---|---|---|
| Localização (quando em uso / sempre) | Rastreamento GPS do transporte e deteção automática de chegada ao destino | `ios/App/App/Info.plist`, `android/app/src/main/AndroidManifest.xml` |
| Câmara | Fotos de evidência de entrega e documentos de verificação | idem |
| Galeria de fotos | Anexar imagens já existentes no telemóvel | idem |

Se a Apple ou a Google pedirem para justificar alguma permissão, as descrições
já escritas no `Info.plist` (em português) costumam bastar — ajusta o texto se
quiseres ser mais específico.

### Limitação conhecida: GPS só funciona com a app aberta

O rastreamento de localização (botão "Partilhar localização" do transportador)
só envia posições enquanto a app está aberta e em primeiro plano — é assim de
propósito, para não teres de justificar à Google e à Apple o uso de localização
em segundo plano (que exige formulários extra e aumenta bastante o risco de
rejeição). Isto é suficiente para a maioria dos casos (o motorista ou estafeta
mantém a app aberta durante a entrega), mas se mais tarde quiseres GPS mesmo
com o ecrã apagado ou a app minimizada, isso exige um plugin de localização em
segundo plano (ex.: `@capacitor-community/background-geolocation`) e uma
declaração formal de uso junto da Google Play — é um passo adicional
deliberadamente deixado de fora por agora.

### Testar antes de submeter

Ambas as lojas rejeitam apps com erros óbvios ou ecrãs em branco. Antes de
submeteres, testa num emulador (Android Studio) e idealmente num iPhone físico
(o simulador do Xcode não dá acesso a GPS real). Confirma que o PIN por SMS, o
upload de fotos e o rastreamento GPS funcionam dentro da app, não só no browser.
