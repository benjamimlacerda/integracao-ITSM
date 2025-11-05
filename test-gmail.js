const nodemailer = require("nodemailer");

async function testar() {
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            type: "OAuth2",
            user: process.env.GMAIL_USER,
            clientId: process.env.GMAIL_CLIENT_ID,
            clientSecret: process.env.GMAIL_CLIENT_SECRET,
            refreshToken: process.env.GMAIL_REFRESH_TOKEN,
        },
    });

    try {
        console.log("🔄 Testando envio...");
        await transporter.verify();
        console.log("✅ Conexão com Gmail OK");
    } catch (error) {
        console.error("❌ Falha ao conectar:", error);
    }
}

testar();
