require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const nodemailer = require("nodemailer");
const https = require("https");

const app = express();
app.use(bodyParser.json());
app.use(express.json());

// Instância do axios ignorando erros de SSL
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false, // ⚠️ Ignora certificado inválido
    }),
    timeout: 15000, // Timeout de 15s
});

// Configurações do SDP
const SDP_URL = process.env.SDP_URL || "https://172.20.0.22:8443/api/v3/requests";
const SDP_API_KEY = process.env.SDP_API_KEY;
const PORT = process.env.PORT || 5050;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor escutando WEBHOOK na porta ${PORT}`);
});

// ===================================================
// 🔹 Abrir chamado no MSP a partir do OTRS
// ===================================================
app.post("/abrir-chamado-msp", async (req, res) => {
    const ticket = req.body.Ticket || {};
    const artigo = req.body.Article || {};

    const titulo = ticket.Title || "Sem título";
    const assunto = artigo.Subject || "Sem assunto";
    const owner = ticket.Owner || "Desconhecido";
    const ticket_number = ticket.TicketNumber || "Sem número";
    const priority = ticket.Priority || "Sem prioridade";
    const state = ticket.State || "Sem estado";
    const customerUser = ticket.CustomerUser || "Desconhecido";

    const emailCliente = artigo.From?.match(/<(.+)>/)?.[1] || "email@desconhecido.com";

    // --- Lógica para limpar o corpo do texto ---
    let corpoOriginal = artigo.Body || "Sem corpo";
    let corpoFormatado = corpoOriginal;

    const regexDescricao = /Descrição:\n\n(.+)/s;
    const matchDescricao = corpoOriginal.match(regexDescricao);
    if (matchDescricao && matchDescricao[1]) {
        corpoFormatado = matchDescricao[1];
    }

    corpoFormatado = corpoFormatado.replace(/\[\d+\]http:\/\/.+/g, '');
    corpoFormatado = corpoFormatado.replace(/-- Service Desk Aena Brasil/g, '');
    corpoFormatado = corpoFormatado.replace(/Desenvolvido por LigeroSmart 6/g, '');
    corpoFormatado = corpoFormatado.replace(/\n\s*\n/g, '\n');
    corpoFormatado = corpoFormatado.trim();

    const attachment = artigo.Attachment?.[0];

    let transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
            user: "benjamim.lacerda@nv7.com.br",
            pass: process.env.SENHA_GMAIL,
        },
        logger: true,
        debug: true,
        tls: { rejectUnauthorized: true },
    });

    let mailOptions = {
        from: "benjamim.lacerda@nv7.com.br",
        to: "atendimento@nv7.com.br",
        subject: `[OTRS ${ticket_number}] Novo chamado: ${titulo}`,
        text: `Novo chamado recebido do OTRS:\n\nAberto por: ${owner}\nEmail do solicitante: ${emailCliente}\nAssunto: ${assunto}\nPrioridade: ${priority}\nStatus: ${state}\nNúmero do ticket OTRS: ${ticket_number}\nUsuário solicitante: ${customerUser}\n\n\n${corpoFormatado}\n`,
        attachments: attachment
            ? [{
                filename: attachment.Filename,
                content: Buffer.from(attachment.Content, "base64"),
                contentType: attachment.ContentType || "application/octet-stream",
            }]
            : [],
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Email enviado:", info.response);
        res.status(200).json({ status: "Email enviado com sucesso", info: info.response });
    } catch (error) {
        console.error("Erro ao enviar email:", error);
        res.status(500).json({ error: "Falha ao enviar email", detalhes: error.message });
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

        const mspResponse = await axios.put(
            `https://suporte.nv7.com.br/api/v3/requests/${requestId}`,
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

        const respostaAtualizacao = await axios.put(
            `https://suporte.nv7.com.br/api/v3/requests/${MSPID}`,
            updatePayload,
            { headers: { authtoken: SDP_API_KEY, "Content-Type": "application/json" } }
        );

        res.json({ success: true, response: respostaAtualizacao.data });
    } catch (error) {
        console.error("[ERROR] Falha ao atualizar chamado:", error.response?.data || error.message);
        res.status(500).json({ error: "Falha ao atualizar chamado", details: error.response?.data || error.message });
    }
});

