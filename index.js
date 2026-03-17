import { Telegraf, Markup } from 'telegraf';
import pg from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';

// ==========================================
// BLOCO 1: CONFIGURAÇÕES E INICIALIZAÇÃO
// ==========================================
dotenv.config();

// Servidor Web "Falso" para manter o bot vivo no Render
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('📚 Bot Macunaíma está Online e rodando!'));
app.listen(port, () => console.log(`Servidor web rodando na porta ${port}`));

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Gerenciador de estado em memória
const userStates = new Map(); 

// ==========================================
// BLOCO 2: CONEXÃO COM O BANCO DE DADOS (POSTGRESQL)
// ==========================================
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Necessário para bancos na nuvem
});

// Cria a tabela automaticamente ao iniciar
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS dicionario (
            id SERIAL PRIMARY KEY,
            palavra TEXT UNIQUE NOT NULL,
            significado TEXT NOT NULL,
            pagina INTEGER NOT NULL,
            capitulo INTEGER NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log("Banco de dados sincronizado.");
}
initDB();

// ==========================================
// BLOCO 3: SERVIÇOS (IA e CSV)
// ==========================================
async function buscarSignificado(palavra) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Defina a palavra "${palavra}" de forma clara e direta, focando no seu uso na literatura brasileira, regionalismo ou origens indígenas, especificamente no contexto do livro Macunaíma de Mário de Andrade. 
    Forneça uma explicação em no máximo 2 parágrafos. 
    OBRIGATÓRIO: Ao final da resposta, quebre uma linha e adicione exatamente "📝 Resumo para anotação:", seguido de uma definição extremamente curta e direta, com no máximo duas frases.`;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

function gerarCSV(dados, nomeArquivo) {
    let csvContent = '\uFEFF'; // BOM para acentuação UTF-8 no Excel
    csvContent += 'Palavra;Página;Capítulo;Significado\n';
    
    dados.forEach(row => {
        const significadoLimpo = row.significado.replace(/(\r\n|\n|\r)/gm, " "); 
        csvContent += `${row.palavra};${row.pagina};${row.capitulo};"${significadoLimpo}"\n`;
    });

    fs.writeFileSync(nomeArquivo, csvContent, 'utf8');
    return nomeArquivo;
}

// ==========================================
// BLOCO 4: COMANDOS DE GERENCIAMENTO
// ==========================================
bot.command('cancelar', (ctx) => {
    if (userStates.has(ctx.chat.id)) {
        userStates.delete(ctx.chat.id);
        return ctx.reply('🛑 Operação cancelada com sucesso.');
    }
    return ctx.reply('Nenhuma operação pendente.');
});

bot.command('excluir', async (ctx) => {
    const palavra = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!palavra) return ctx.reply('⚠️ Uso correto: /excluir [palavra]');
    
    const res = await pool.query('DELETE FROM dicionario WHERE palavra = $1', [palavra]);
    if (res.rowCount > 0) return ctx.reply(`🗑️ "${palavra}" removida do dicionário.`);
    return ctx.reply(`❌ "${palavra}" não encontrada.`);
});

// Comando para listar todas as palavras no próprio chat
bot.command('listar', async (ctx) => {
  try {
      const res = await pool.query('SELECT palavra, pagina, capitulo FROM dicionario ORDER BY palavra ASC');
      if (res.rowCount === 0) return ctx.reply('O dicionário está vazio.');
      
      let msg = '📖 **Índice Macunaíma**\n\n';
      res.rows.forEach(p => {
          msg += `- **${p.palavra}** (Pág. ${p.pagina} | Cap. ${p.capitulo})\n`;
      });
      return ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
      console.error('Erro no /listar:', error);
      ctx.reply('❌ Erro ao buscar a lista.');
  }
});

// Comando para listar palavras por uma página específica
bot.command('pagina', async (ctx) => {
  const parametro = ctx.message.text.split(' ')[1];
  const numero = parseInt(parametro);
  
  if (isNaN(numero)) return ctx.reply('⚠️ Uso correto: /pagina [numero]\nExemplo: /pagina 42');

  try {
      const res = await pool.query('SELECT palavra FROM dicionario WHERE pagina = $1 ORDER BY palavra ASC', [numero]);
      if (res.rowCount === 0) return ctx.reply(`Nenhuma palavra registrada na página ${numero}.`);

      let msg = `📍 **Palavras da Página ${numero}**\n\n`;
      res.rows.forEach(p => {
          msg += `- **${p.palavra}**\n`;
      });
      return ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
      console.error('Erro no /pagina:', error);
      ctx.reply('❌ Erro ao buscar as palavras.');
  }
});

// Painel interativo de exportação
bot.command('exportar', (ctx) => {
    return ctx.reply('Como você deseja ordenar o seu arquivo CSV?', 
        Markup.inlineKeyboard([
            [Markup.button.callback('🔤 Ordem Alfabética', 'export_alpha')],
            [Markup.button.callback('📑 Por Página', 'export_page')],
            [Markup.button.callback('📚 Por Capítulo', 'export_chapter')]
        ])
    );
});

// ==========================================
// BLOCO 5: AÇÕES DOS BOTÕES (EXPORTAÇÃO)
// ==========================================
bot.action(/export_.+/, async (ctx) => {
    const action = ctx.match[0];
    let query = '';
    let nomeArquivo = '';

    if (action === 'export_alpha') {
        query = 'SELECT * FROM dicionario ORDER BY palavra ASC';
        nomeArquivo = 'macunaima_alfabetica.csv';
    } else if (action === 'export_page') {
        query = 'SELECT * FROM dicionario ORDER BY pagina ASC, palavra ASC';
        nomeArquivo = 'macunaima_paginas.csv';
    } else if (action === 'export_chapter') {
        query = 'SELECT * FROM dicionario ORDER BY capitulo ASC, pagina ASC';
        nomeArquivo = 'macunaima_capitulos.csv';
    }

    try {
        const res = await pool.query(query);
        if (res.rowCount === 0) return ctx.reply('O dicionário está vazio.');

        await ctx.reply('⏳ Gerando arquivo CSV...');
        const filePath = gerarCSV(res.rows, nomeArquivo);
        await ctx.replyWithDocument({ source: filePath });
        fs.unlinkSync(filePath); // Limpa o arquivo temp
    } catch (error) {
        console.error(error);
        ctx.reply('❌ Erro ao gerar o arquivo.');
    }
});

// ==========================================
// BLOCO 6: FLUXO PRINCIPAL (A MÁQUINA DE ESTADOS)
// ==========================================
bot.on('text', async (ctx) => {
    // Ignora comandos digitados sem a barra acidentalmente
    if (ctx.message.text.startsWith('/')) return;
    
    const chatId = ctx.chat.id;
    const textoUsuario = ctx.message.text.trim().toLowerCase();
  
    if (textoUsuario === "cancelar") return ctx.reply('Dica: Use o comando /cancelar.');

    // --- MÁQUINA DE ESTADOS (Múltiplas perguntas) ---
    if (userStates.has(chatId)) {
        const estadoAtual = userStates.get(chatId);
        const numeroDigitado = parseInt(textoUsuario);
        
        if (isNaN(numeroDigitado)) return ctx.reply('⚠️ Por favor, digite apenas números.');

        if (estadoAtual.step === 'PAGINA') {
            estadoAtual.paginaSalva = numeroDigitado;
            estadoAtual.step = 'CAPITULO';
            userStates.set(chatId, estadoAtual);
            return ctx.reply('📍 Perfeito. E em qual **capítulo** ela está? (Digite 0 para epílogo/prefácio)', { parse_mode: 'Markdown' });
        }
        
        if (estadoAtual.step === 'CAPITULO') {
            try {
                await pool.query(
                    'INSERT INTO dicionario (palavra, significado, pagina, capitulo) VALUES ($1, $2, $3, $4)',
                    [estadoAtual.palavra, estadoAtual.significado, estadoAtual.paginaSalva, numeroDigitado]
                );
                ctx.reply(`✅ Salvo! "${estadoAtual.palavra}" na pág ${estadoAtual.paginaSalva}, cap ${numeroDigitado}.`);
            } catch (error) {
                ctx.reply('❌ Erro ao salvar no banco. Pode ser que a palavra já exista.');
                console.error(error);
            } finally {
                userStates.delete(chatId);
            }
            return;
        }
    }
  
    // --- BUSCA INICIAL DE PALAVRA ---
    const palavra = textoUsuario;
    
    try {
        const res = await pool.query('SELECT * FROM dicionario WHERE palavra = $1', [palavra]);
        
        if (res.rowCount > 0) {
            const r = res.rows[0];
            return ctx.reply(`📚 **${r.palavra.toUpperCase()}** (Pág. ${r.pagina} | Cap. ${r.capitulo})\n\n${r.significado}`, { parse_mode: 'Markdown' });
        }
      
        const loadingMsg = await ctx.reply('🔍 Buscando significado...');
        const significado = await buscarSignificado(palavra);
        await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, `📖 **${palavra.toUpperCase()}**\n\n${significado}\n\n📍 *Em qual página você encontrou?* (Apenas números)`, { parse_mode: 'Markdown' });
        
        userStates.set(chatId, { palavra, significado, step: 'PAGINA' });

    } catch (error) {
        ctx.reply('❌ Ocorreu um erro na busca.');
        console.error(error);
    }
});
  
// ==========================================
// BLOCO 7: INICIALIZAÇÃO
// ==========================================
bot.launch().then(() => console.log('Bot rodando no Telegram!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));