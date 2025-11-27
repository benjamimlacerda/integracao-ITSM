require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(bodyParser.json());
app.use(express.json());


app.use((req, res, next) => {
  console.log(">>> Nova requisição recebida:");
  console.log("Método:", req.method);
  console.log("URL:", req.url);
  console.log("Headers:", req.headers);
  next();
});


// ===================================================
// 🔧 CONFIGURAÇÕES GERAIS
// ===================================================
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false, // ignora SSL interno
  })
});

const SDP_URL = process.env.SDP_URL || "https://suporte.nv7.com.br/api/v3/requests";
const SDP_API_KEY = process.env.SDP_API_KEY;
const PORT = process.env.PORT || 8080;

// ===================================================
// 🚀 INICIAR SERVIDOR
// ===================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor escutando WEBHOOK na porta ${PORT}`);
});

// ===================================================
// 🔹 ROTA: Abrir chamado no MSP (OTRS → MSP)
// ===================================================
app.post("/abrir-chamado-msp", async (req, res) => {
    try {
        const ticket = req.body.Ticket || {};
        const artigo = req.body.Article || {};

        const titulo = ticket.Title || "Sem título";
        const ticket_number = ticket.TicketNumber || "Sem número";
        const priority = ticket.Priority || "Sem prioridade";
        const state = ticket.State || "Sem estado";
        const owner = ticket.Owner || "Desconhecido";
        const customerUser = ticket.CustomerUser || "Desconhecido";
        const emailCliente = artigo.From?.match(/<(.+)>/)?.[1] || "email@desconhecido.com";

        // --- 🧹 LIMPEZA DO CORPO (SANITIZAÇÃO) ---
        let rawBody = (artigo.Body || "");

        // 1. Remove a linha de assunto repetida no corpo "[Ticket#...] Ticket criado: ..."
        rawBody = rawBody.replace(/^\s*\[Ticket#.+?\] Ticket criado:.+?$/gm, "");

        // 2. Remove o bloco de saudação automática ("Prezado(a)... até ... escreveu:")
        // O '[\s\S]+?' pega tudo (incluindo quebras de linha) de forma não-gulosa até encontrar 'escreveu:'
        rawBody = rawBody.replace(/Prezado\(a\)[\s\S]+?escreveu:/g, "");

        // 3. Remove os links de referência do OTRS (ex: [1]http://...)
        rawBody = rawBody.replace(/\[\d+\]\s*http\S+/g, "");

        // 4. Remove a assinatura do sistema (-- Service Desk ...) e tudo que vem depois
        rawBody = rawBody.replace(/--\s*Service Desk[\s\S]*/g, "");

        // 5. Remove "Desenvolvido por..." caso tenha sobrado
        rawBody = rawBody.replace(/Desenvolvido por.+/g, "");

        // 6. Limpa espaços extras no começo e fim
        rawBody = rawBody.trim();

        // Se o corpo ficar vazio após a limpeza (comum se for só notificação), coloca um fallback
                if (!rawBody) rawBody = "(Descrição original vazia ou contida apenas no anexo)";

        // 7. Conversão Final para HTML
                let corpoHtml = rawBody
                    .replace(/>\s*/g, '')
                    // Garante que cada linha limpa seja separada
                    .replace(/\n/g, "<br>")
                    // Remove linhas vazias duplas criadas pelo <br>
                    .replace(/<br>\s*<br>/g, '<br>');

        // --- FIM DA LIMPEZA ---

        const description_details = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333;">
        ${corpoHtml}
    </div>
    <br>
    <hr style="border: 0; border-top: 1px solid #ccc;">
    <div style="background-color: #f4f6f8; padding: 12px; border-radius: 6px; font-size: 13px; color: #555;">
        <h3 style="margin: 0 0 10px 0; font-size: 15px; color: #004d99;">📄 Dados do Ticket OTRS</h3>
        <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 4px; font-weight: bold;">Ticket:</td><td>${ticket_number}</td></tr>
            <tr><td style="padding: 4px; font-weight: bold;">Solicitante:</td><td>${customerUser}</td></tr>
            <tr><td style="padding: 4px; font-weight: bold;">Email:</td><td>${emailCliente}</td></tr>
            <tr><td style="padding: 4px; font-weight: bold;">Prioridade:</td><td>${priority}</td></tr>
            <tr><td style="padding: 4px; font-weight: bold;">Fila:</td><td>${ticket.Queue || "N/A"}</td></tr>
        </table>
    </div>
    `;

        const input_data = {
            request: {
                subject: `[OTRS ${ticket_number}] ${titulo}`,
                description: description_details,
                requester: {
                    id: "20703",
                    name: "Benjamim Lacerda"
                },
                resolution: {
                    content: "Chamado criado automaticamente via integração OTRS"
                },
                mode: { name: "Web", id: "2" },
                priority: { color: "#0066ff", name: "Baixa", id: "301" },
                category: { name: "Crowdstrike", id: "601" },
                site: { name: "ContaTeste", id: "304" },
                account: { name: "ContaTeste", id: "303" },
                status: { name: "Aberto" }
            }
        };

        console.log("📤 Payload Limpo:", JSON.stringify(input_data.request.description, null, 2));

        const data = new URLSearchParams();
        data.append("input_data", JSON.stringify(input_data));

        const abrirChamado = await axiosInstance.post(
            SDP_URL,
            data,
            {
                headers: {
                    authtoken: SDP_API_KEY,
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }
        );

        console.log("✅ Chamado criado com sucesso:", abrirChamado.data);
        res.status(201).json({ message: "Chamado criado no MSP", data: abrirChamado.data });

    } catch (error) {
        console.error("❌ Erro:", error.message);
        res.status(500).json({ error: "Erro interno", detalhes: error.message });
    }
});

// ===================================================
// 🔹 Ticket Create (MSP → OTRS)
// ===================================================
app.post("/abrir-chamado-OTRS", async (req, res) => {
    try {
        const payload = req.body;

        // Verifica se o payload veio correto
        if (!payload?.Ticket?.Title || !payload?.Article?.Subject) {
            return res.status(400).json({ error: "Payload inválido: Ticket.Title ou Article.Subject ausente" });
        }

        // Extrair valores
        const requestId = payload.Article.Subject; // Aqui vem o ID do chamado no MSP
        const subject = payload.Ticket.Title;

        console.log(`[INFO] MSP RequestID: ${requestId}`);
        console.log(`[INFO] Título original: ${subject}`);

        // Enviar para OTRS
        const otrsResponse = await axios.post(
            "https://sd.aenabrasil.com.br/otrs/nph-genericinterface.pl/Webservice/MSS-NV7/TicketCreate",
            payload,
            { headers: { "Content-Type": "application/json" } }
        );

        console.log("[INFO] Resposta do OTRS:", otrsResponse.data);

        const { TicketNumber } = otrsResponse.data;

        if (!TicketNumber) {
            return res.status(500).json({ error: "OTRS não retornou TicketNumber" });
        }

        // Novo título formatado
        const novoTitulo = `[OTRS ${TicketNumber}] Novo chamado: ${subject}`;

        // Atualizar título no MSP
        const mspUpdatePayload = {
            request: {
                subject: novoTitulo
            }
        };

        console.log(`[INFO] Atualizando título no MSP (RequestID: ${requestId}) → ${novoTitulo}`);

        // 🛠️ CORREÇÃO 2: Trocando axios.put por axiosInstance.put
        const mspResponse = await axiosInstance.put(
            `${SDP_URL}/${requestId}`,
            mspUpdatePayload,
            {
                headers: {
                    authtoken: SDP_API_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("[INFO] Resposta do MSP:", mspResponse.data);

        res.json({
            success: true,
            otrs: otrsResponse.data,
            msp: mspResponse.data
        });

    } catch (error) {
        console.error("[ERROR] Falha ao abrir chamado no OTRS:", error.response?.data || error.message);
        res.status(500).json({
            error: "Erro ao abrir chamado no OTRS",
            details: error.response?.data || error.message
        });
    }
});



// ===================================================
// 🔹 Atualizar chamado no MSP (OTRS → MSP)
// ===================================================
app.post("/atualizar-chamado-msp", async (req, res) => {
    try {
        const ticketData = req.body.Ticket || {};
        const articleData = req.body.Article || {};

        const TicketNumber = ticketData.TicketNumber;
        const Title = ticketData.Title;
        const Description = articleData.Body || "Sem descrição";
        const From = articleData.From?.match(/<(.+)>/)?.[1] || "email@desconhecido.com";

        if (!TicketNumber) {
            return res.status(400).json({ error: "Número do ticket ausente no payload" });
        }

        console.log(`[INFO] Ticket number recebido do OTRS: ${TicketNumber}`);

        const searchResponse = await axiosInstance.get(SDP_URL, { headers: { authtoken: SDP_API_KEY } });
        const chamados = searchResponse.data.requests || [];
        console.log(`[DEBUG] Total de chamados no MSP: ${chamados.length}`);

        const chamado = chamados.find(c => {
            if (!c.subject) return false;
            const match = c.subject.match(/\[OTRS (\d+)\]/);
            return match && match[1] === TicketNumber;
        });

        if (!chamado) {
            console.warn(`[WARN] Chamado com OTRS ${TicketNumber} não encontrado no MSP`);
            return res.status(404).json({ error: `Chamado com OTRS ${TicketNumber} não encontrado no MSP.` });
        }

        const idChamado = chamado.id;
        console.log(`[INFO] Chamado encontrado no MSP: ID ${idChamado}, Subject: "${chamado.subject}"`);

        const input_data = {
            notification: {
                subject: `Re: [Request ID : ${idChamado}] : ${Title}`,
                description: `${Description}`,
                to: [{ email_id: `${From}` }],
                type: "reply"
            }
        };

        const data = new URLSearchParams();
        data.append("input_data", JSON.stringify(input_data));

        const respostaComentario = await axiosInstance.post(
            `${SDP_URL}/${idChamado}/notifications`,
            data,
            { headers: { authtoken: SDP_API_KEY, "Content-Type": "application/x-www-form-urlencoded" } }
        );

        console.log(`[SUCCESS] Chamado ${idChamado} comentado com sucesso`);
        res.json({ status: "Chamado comentado no MSP com sucesso", chamado: idChamado, respostaFechamento: respostaComentario.data });

    } catch (error) {
        console.error("[ERROR] Falha ao comentar chamado no MSP:", error.response?.data || error.message);
        res.status(500).json({ error: "Falha ao comentar chamado no MSP", detalhes: error.response?.data || error.message });
    }
});



app.post("/atualizar-chamado-otrs", async (req, res) => {
    try {
        const { TicketNumber, Article } = req.body;
        const requestId = Article?.Subject; // ID do chamado no MSP

        if (!TicketNumber || !requestId) {
            return res.status(400).json({ error: "requestId ausente no payload" });
        }

        // Extrair o número do OTRS do formato [OTRS 2025090910000143]
        const match = TicketNumber.match(/\[OTRS (\d+)\]/);
        if (!match) {
            return res.status(400).json({ error: "TicketNumber não está no formato esperado" });
        }
        const otrsTicketNumber = match[1];
        console.log(`[INFO] Número OTRS extraído: ${otrsTicketNumber}`);

        // Função para limpar HTML → transforma em texto puro
        function stripHtml(html) {
            return html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/div>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .trim();
        }

        // Buscar notificações no MSP
        const notifResponse = await axiosInstance.get(
            `${SDP_URL}/${requestId}/notifications`,
            { headers: { authtoken: SDP_API_KEY } }
        );

        const notifications = notifResponse.data.notifications || [];
        if (notifications.length === 0) {
            return res.status(404).json({ error: "Nenhuma notificação encontrada no MSP" });
        }

        // Pegar a notificação mais recente pelo sent_time.value
        const latestNotif = notifications.reduce((latest, current) => {
            return parseInt(current.sent_time.value) > parseInt(latest.sent_time.value)
                ? current
                : latest;
        });

        console.log(`[INFO] Última notificação encontrada: ID ${latestNotif.id}`);

        // Limpar HTML para texto puro
        const bodyClean = stripHtml(latestNotif.description || "");

        // Montar payload para OTRS
        const payload = {
            UserLogin: "nv7.integracao",
            Password: "e2gPVQodh7hty8INSu354Z",
            TicketNumber: otrsTicketNumber,
            Article: {
                Subject: latestNotif.subject || "Atualização de chamado",
                From: "mss@nv7.com.br",
                Body: bodyClean, // TEXTO LIMPO
                MimeType: "text/html",
                Charset: "utf-8"
            }
        };

        console.log("[DEBUG] Payload que seria enviado ao OTRS:", JSON.stringify(payload, null, 2));

        // Enviar para OTRS
        const otrsResponse = await axios.post(
            "https://sd.aenabrasil.com.br/otrs/nph-genericinterface.pl/Webservice/MSS-NV7/TicketUpdate",
            payload,
            { headers: { "Content-Type": "application/json" } }
        );

        console.log("[INFO] Resposta do OTRS:", otrsResponse.data);

        res.json({ success: true, response: otrsResponse.data });

    } catch (error) {
        console.error("[ERROR] Falha ao processar atualização de chamado:", error.response?.data || error.message);
        res.status(500).json({ error: "Erro ao processar atualização de chamado", details: error.message });
    }
});


// ===================================================
// 🔹 Fechar chamado no OTRS (MSP → OTRS)
// ===================================================
app.post("/fechar-chamado-otrs", async (req, res) => {
    try {
        const { TicketNumber, Ticket, Article, UserLogin, Password } = req.body;

        if (!TicketNumber) {
            return res.status(400).json({ error: "TicketNumber ausente no payload" });
        }
        if (!Article?.Subject) {
            return res.status(400).json({ error: "Article.Subject (requestId do MSP) ausente no payload" });
        }

        // Extrair o número do OTRS do formato [OTRS 2025090910000143]
        const match = TicketNumber.match(/\[OTRS (\d+)\]/);
        if (!match) {
            return res.status(400).json({ error: "TicketNumber não está no formato esperado" });
        }
        const otrsTicketNumber = match[1];
        console.log(`[INFO] Número OTRS extraído: ${otrsTicketNumber}`);

        // Pegar o requestId do MSP a partir do Article.Subject
        const requestId = Article.Subject.trim();
        console.log(`[INFO] Request ID recebido do MSP: ${requestId}`);

        // Buscar resolução no MSP
        const resResponse = await axiosInstance.get(
            `${SDP_URL}/${requestId}/resolutions`,
            { headers: { authtoken: SDP_API_KEY } }
        );

        const resolution = resResponse.data.resolution;
        if (!resolution) {
            return res.status(404).json({ error: "Nenhuma resolução encontrada no MSP" });
        }

        console.log(`[INFO] Resolução encontrada em: ${resolution.submitted_on.display_value}`);

        // Função para limpar HTML
        function stripHtml(html) {
            return html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/div>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .trim();
        }
        const bodyClean = stripHtml(resolution.content || "");

        // Montar payload final para OTRS
        const payload = {
            UserLogin: UserLogin || "nv7.integracao",
            Password: Password || "e2gPVQodh7hty8INSu354Z",
            TicketNumber: otrsTicketNumber,
            Ticket: {
                State: "Resolvido",
                PendingTime: Ticket?.PendingTime || { Diff: "259200" }
            },
            Article: {
                IsVisibleForCustomer: Article?.IsVisibleForCustomer || 1,
                Subject: "Encerramento do chamado",
                From: "mss@nv7.com.br",
                Body: bodyClean || "Chamado encerrado pelo MSP.",
                MimeType: Article?.MimeType || "text/html",
                Charset: Article?.Charset || "utf-8"
            }
        };

        console.log("[DEBUG] Payload enviado ao OTRS:", JSON.stringify(payload, null, 2));

        // Enviar para OTRS
        const otrsResponse = await axios.post(
            "https://sd.aenabrasil.com.br/otrs/nph-genericinterface.pl/Webservice/MSS-NV7/TicketUpdate",
            payload,
            { headers: { "Content-Type": "application/json" } }
        );

        console.log("[INFO] Resposta do OTRS:", otrsResponse.data);

        res.json({ success: true, response: otrsResponse.data });

    } catch (error) {
        console.error("[ERROR] Falha ao processar fechamento de chamado:", error.response?.data || error.message);
        res.status(500).json({
            error: "Erro ao processar fechamento de chamado",
            details: error.response?.data || error.message
        });
    }
});


// ===================================================
// 🔹 Fechar chamado no MSP (OTRS → MSP)
// ===================================================
app.post("/fechar-chamado-msp", async (req, res) => {
    try {
        const TicketNumber = req.body.TicketNumber || req.body.Ticket?.TicketNumber;
        if (!TicketNumber) {
            return res.status(400).json({ error: "Número do ticket ausente no payload" });
        }

        console.log(`[INFO] Ticket number recebido do OTRS: ${TicketNumber}`);

        const searchResponse = await axiosInstance.get(SDP_URL, { headers: { authtoken: SDP_API_KEY } });
        const chamados = searchResponse.data.requests || [];
        console.log(`[DEBUG] Total de chamados no MSP: ${chamados.length}`);

        const chamado = chamados.find(c => {
            if (!c.subject) return false;
            const match = c.subject.match(/\[OTRS (\d+)\]/);
            return match && match[1] === TicketNumber;
        });

        if (!chamado) {
            console.warn(`[WARN] Chamado com OTRS ${TicketNumber} não encontrado no MSP`);
            return res.status(404).json({ error: `Chamado com OTRS ${TicketNumber} não encontrado no MSP.` });
        }

        const idChamado = chamado.id;
        console.log(`[INFO] Chamado encontrado no MSP: ID ${idChamado}, Subject: "${chamado.subject}"`);

        const closurePayload = {
            request: {
                closure_info: {
                    requester_ack_resolution: true,
                    requester_ack_comments: "Fechamento via integração OTRS",
                    closure_comments: "Chamado encerrado pelo OTRS",
                    closure_code: { name: "success" }
                }
            }
        };

        const respostaFechamento = await axiosInstance.put(
            `${SDP_URL}/${idChamado}/close`,
            closurePayload,
            { headers: { authtoken: SDP_API_KEY, "Content-Type": "application/json" } }
        );

        console.log(`[SUCCESS] Chamado ${idChamado} fechado com sucesso`);
        res.json({ status: "Chamado fechado no MSP com sucesso", chamado: idChamado, respostaFechamento: respostaFechamento.data });

    } catch (error) {
        console.error("[ERROR] Falha ao fechar chamado no MSP:", error.response?.data || error.message);
        res.status(500).json({ error: "Falha ao fechar chamado no MSP", detalhes: error.response?.data || error.message });
    }
});

// ===================================================
// 🔹 Alterar Conta (MSPID)
// ===================================================
app.post("/alterar-conta", async (req, res) => {
    try {
        const { MSPID } = req.body.request || {};

        if (!MSPID) {
            return res.status(400).json({ error: "MSPID ausente no payload" });
        }

        const updatePayload = {
            request: {
                account: { name: "AENA", id: 1 },
                requester: { name: "Kaio Henrique Lopes", email_id: "khlopes@aenabrasil.com" }
            }
        };

        // 🛠️ CORREÇÃO 3: Trocando axios.put por axiosInstance.put
        const respostaAtualizacao = await axiosInstance.put(
            `${SDP_URL}/${MSPID}`,
            updatePayload,
            { headers: { authtoken: SDP_API_KEY, "Content-Type": "application/json" } }
        );

        res.json({ success: true, response: respostaAtualizacao.data });
    } catch (error) {
        console.error("[ERROR] Falha ao atualizar chamado:", error.response?.data || error.message);
        res.status(500).json({ error: "Falha ao atualizar chamado", details: error.response?.data || error.message });
    }
});

app.get("/myip", async (req, res) => {
  try {
    const resp = await axios.get("https://ifconfig.co/json");
    res.json(resp.data);
  } catch (e) {
    res.json({ error: e.message });
  }
});
