import type { CapacitorConfig } from '@capacitor/cli';

// IMPORTANTE: depois de publicares o backend no Render, substitui o valor de
// server.url abaixo pelo teu endereço real (ex.: 'https://epyalink.onrender.com').
// A app carrega o site diretamente desse endereço, como uma "janela nativa" com
// acesso a GPS, câmara e notificações — isto significa que QUALQUER atualização
// que fizeres ao site (novas funcionalidades, correções) aparece na app de
// imediato, sem teres de submeter uma nova versão às lojas.
//
// Se preferires uma app 100% offline-first (os ficheiros vão dentro da app, sem
// depender do servidor para a interface, só para os dados), remove o bloco
// "server" todo — nesse caso o Capacitor usa os ficheiros de webDir (public/)
// diretamente, mas tens de mudar as chamadas fetch('/api/...') no index.html
// para um endereço absoluto (ex.: 'https://epyalink.onrender.com/api/...').
const config: CapacitorConfig = {
  appId: 'com.nuvemjv.epyalink',
  appName: 'EPYALINK',
  webDir: 'public',
  server: {
    url: 'https://SUBSTITUI-PELO-TEU-DOMINIO.onrender.com',
    cleartext: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#2F5233',
      androidSplashResourceName: 'splash',
      showSpinner: false
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#2F5233'
    }
  }
};

export default config;
