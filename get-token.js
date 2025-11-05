const { google } = require('googleapis');
const readline = require('readline');

const oAuth2Client = new google.auth.OAuth2(
    '549012176655-alvkvqi2tla6lb39nr66vq1o3fl01m5s.apps.googleusercontent.com',
    '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',
    'https://developers.google.com/oauthplayground'
);

const SCOPES = ['https://mail.google.com/'];

const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
});

console.log('Abra este link e autorize o app:', authUrl);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Cole o código de autorização aqui: ', async (code) => {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('Seu Refresh Token é:', tokens.refresh_token);
    rl.close();
});
