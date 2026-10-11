const fetch = require('node-fetch');
async function calcularRota(coordenadasOrigem, coordenadasDestino) {
    const apiKey =  process.env.OPENROUTESERVICE_API_KEY; // Certifique-se de definir sua chave de API no ambiente
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${apiKey}&start=${coordenadasOrigem[1]},${coordenadasOrigem[0]}&end=${coordenadasDestino[1]},${coordenadasDestino[0]}`; 
    const body = {
        coordinates: [coordenadasOrigem, coordenadasDestino],
        format: 'geojson'
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': apiKey
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`Erro na requisição: ${response.statusText}`);
        }

        const data =data.features[0].properties.summary;
        return{
            distanciaKm:(calcularRota.distance / 1000).toFixed(2),
            duracaoMinutos:(calcularRota.duration / 60).toFixed(1),
            geometria: data.features[0].geometry   
        };
    }   catch (error) {
        console.error('[ORS]Erro ao calcular a rota:', error);
        throw error;
    }
        }
    module.exports = { calcularRota };
