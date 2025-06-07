const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// 資料庫連接
const pool = new Pool({
    connectionString: 'postgres://koyeb-adm:npg_DIp9jF1wrEek@ep-divine-voice-a229hdy4.eu-central-1.pg.koyeb.app/koyebdb',
    ssl: {
        rejectUnauthorized: false
    }
});

// Discord 客戶端設置
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// 初始化資料庫表格
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_checkin (
                user_id VARCHAR(20) PRIMARY KEY,
                username VARCHAR(100),
                total_points INTEGER DEFAULT 0,
                total_exp INTEGER DEFAULT 0,
                consecutive_days INTEGER DEFAULT 0,
                last_checkin DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ 資料庫初始化完成');
    } catch (error) {
        console.error('❌ 資料庫初始化錯誤:', error);
    }
}

// 檢查是否為連續簽到
function isConsecutiveDay(lastCheckin) {
    if (!lastCheckin) return false;
    
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    
    const lastDate = new Date(lastCheckin);
    
    // 檢查是否為昨天
    return lastDate.toDateString() === yesterday.toDateString();
}

// 檢查今天是否已簽到
function hasCheckedInToday(lastCheckin) {
    if (!lastCheckin) return false;
    
    const today = new Date();
    const lastDate = new Date(lastCheckin);
    
    return today.toDateString() === lastDate.toDateString();
}

// 獲取用戶經驗排名
async function getUserExpRank(userId) {
    try {
        const result = await pool.query(`
            SELECT COUNT(*) + 1 as rank
            FROM user_checkin 
            WHERE total_exp > (
                SELECT COALESCE(total_exp, 0)
                FROM user_checkin 
                WHERE user_id = $1
            )
        `, [userId]);
        
        return result.rows[0]?.rank || 1;
    } catch (error) {
        console.error('獲取排名錯誤:', error);
        return 1;
    }
}

// 處理簽到指令
async function handleCheckin(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    
    try {
        // 查詢用戶資料
        const userResult = await pool.query(
            'SELECT * FROM user_checkin WHERE user_id = $1', 
            [userId]
        );
        
        let userData = userResult.rows[0];
        
        // 檢查今天是否已簽到
        if (userData && hasCheckedInToday(userData.last_checkin)) {
            await interaction.reply({
                content: `❌ **@${username}** 你今天已經簽到過了！明天再來吧～`,
                ephemeral: true
            });
            return;
        }
        
        // 基礎獎勵
        const baseExp = 10;
        const basePoints = 10;
        let bonusExp = 0;
        let bonusPoints = 0;
        let consecutiveDays = 1;
        
        if (userData) {
            // 檢查連續簽到
            if (isConsecutiveDay(userData.last_checkin)) {
                consecutiveDays = userData.consecutive_days + 1;
                bonusExp = 3;
                bonusPoints = 3;
            } else {
                consecutiveDays = 1; // 重新開始計算
            }
            
            // 更新用戶資料
            await pool.query(`
                UPDATE user_checkin 
                SET username = $1,
                    total_points = total_points + $2,
                    total_exp = total_exp + $3,
                    consecutive_days = $4,
                    last_checkin = CURRENT_DATE,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $5
            `, [
                username, 
                basePoints + bonusPoints, 
                baseExp + bonusExp, 
                consecutiveDays, 
                userId
            ]);
            
            // 更新本地資料
            userData.total_points += (basePoints + bonusPoints);
            userData.total_exp += (baseExp + bonusExp);
            userData.consecutive_days = consecutiveDays;
            
        } else {
            // 新用戶首次簽到
            await pool.query(`
                INSERT INTO user_checkin (
                    user_id, username, total_points, total_exp, 
                    consecutive_days, last_checkin
                ) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
            `, [
                userId, username, basePoints, baseExp, consecutiveDays
            ]);
            
            userData = {
                total_points: basePoints,
                total_exp: baseExp,
                consecutive_days: consecutiveDays
            };
        }
        
        // 獲取用戶排名
        const userRank = await getUserExpRank(userId);
        
        // 構建顯示文字
        let expDisplay = `${baseExp}`;
        let pointsDisplay = `${basePoints}`;
        
        if (bonusExp > 0) {
            expDisplay += `(+${bonusExp})`;
            pointsDisplay += `(+${bonusPoints})`;
        }
        
        // 簽到成功訊息
        const successMessage = `**@${username} 成功簽到！**
🎉 獲得了 ${expDisplay} 經驗 和 ${pointsDisplay} 積分！${bonusExp > 0 ? '（連續簽到獎勵！）' : ''}

🔗 已經連續簽到 ${userData.consecutive_days} 天！
💰 當前總積分：${userData.total_points}
🌟 當前總經驗：${userData.total_exp}
🏆 當前經驗排名：第 ${userRank} 名`;
        
        await interaction.reply(successMessage);
        
    } catch (error) {
        console.error('簽到處理錯誤:', error);
        await interaction.reply({
            content: '❌ 簽到時發生錯誤，請稍後再試！',
            ephemeral: true
        });
    }
}

// 處理排行榜指令
async function handleLeaderboard(interaction) {
    try {
        const result = await pool.query(`
            SELECT username, total_exp, total_points, consecutive_days
            FROM user_checkin 
            ORDER BY total_exp DESC, total_points DESC
            LIMIT 10
        `);
        
        if (result.rows.length === 0) {
            await interaction.reply('🎯 還沒有人簽到過呢！快來成為第一個簽到的人吧！');
            return;
        }
        
        let leaderboard = '🏆 **經驗值排行榜 TOP 10** 🏆\n\n';
        
        result.rows.forEach((user, index) => {
            const rank = index + 1;
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
            
            leaderboard += `${medal} **${user.username}**\n`;
            leaderboard += `   📊 經驗: ${user.total_exp} | 積分: ${user.total_points} | 連續: ${user.consecutive_days}天\n\n`;
        });
        
        await interaction.reply(leaderboard);
        
    } catch (error) {
        console.error('排行榜錯誤:', error);
        await interaction.reply({
            content: '❌ 獲取排行榜時發生錯誤！',
            ephemeral: true
        });
    }
}

// 處理個人資訊指令
async function handleUserInfo(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    
    try {
        const result = await pool.query(
            'SELECT * FROM user_checkin WHERE user_id = $1', 
            [userId]
        );
        
        const userData = result.rows[0];
        
        if (!userData) {
            await interaction.reply({
                content: '📝 你還沒有簽到記錄呢！使用 `/簽到` 開始你的簽到之旅吧！',
                ephemeral: true
            });
            return;
        }
        
        const userRank = await getUserExpRank(userId);
        const lastCheckinDate = userData.last_checkin ? 
            new Date(userData.last_checkin).toLocaleDateString('zh-TW') : '從未簽到';
        const canCheckinToday = !hasCheckedInToday(userData.last_checkin);
        
        const infoMessage = `📊 **${userData.username}** 的簽到資訊\n
💰 總積分：**${userData.total_points}**
🌟 總經驗：**${userData.total_exp}**
🔗 連續簽到：**${userData.consecutive_days}** 天
📅 最後簽到：${lastCheckinDate}
🏆 經驗排名：第 **${userRank}** 名
${canCheckinToday ? '\n✅ 今天還可以簽到！' : '\n⏰ 今天已經簽到過了'}`;
        
        await interaction.reply({
            content: infoMessage,
            ephemeral: true
        });
        
    } catch (error) {
        console.error('個人資訊錯誤:', error);
        await interaction.reply({
            content: '❌ 獲取個人資訊時發生錯誤！',
            ephemeral: true
        });
    }
}

// 註冊斜線指令
async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('簽到')
            .setDescription('每日簽到獲得經驗和積分！連續簽到有額外獎勵'),
        
        new SlashCommandBuilder()
            .setName('排行榜')
            .setDescription('查看經驗值排行榜前10名'),
        
        new SlashCommandBuilder()
            .setName('我的資訊')
            .setDescription('查看個人簽到統計資訊')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('🔄 開始註冊斜線指令...');
        
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        
        console.log('✅ 斜線指令註冊成功！');
    } catch (error) {
        console.error('❌ 註冊指令時發生錯誤:', error);
    }
}

// 機器人啟動事件
client.once('ready', async () => {
    console.log(`🤖 ${client.user.tag} 機器人已上線！`);
    console.log(`📊 服務器數量: ${client.guilds.cache.size}`);
    console.log(`👥 總用戶數: ${client.users.cache.size}`);
    
    // 初始化資料庫和註冊指令
    await initDatabase();
    await registerSlashCommands();
    
    console.log('🎯 簽到機器人準備就緒！');
});

// 處理斜線指令交互
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;
    
    console.log(`📝 ${user.username} 使用了指令: /${commandName}`);

    try {
        switch (commandName) {
            case '簽到':
                await handleCheckin(interaction);
                break;
                
            case '排行榜':
                await handleLeaderboard(interaction);
                break;
                
            case '我的資訊':
                await handleUserInfo(interaction);
                break;
                
            default:
                await interaction.reply({
                    content: '❓ 未知的指令！',
                    ephemeral: true
                });
        }
    } catch (error) {
        console.error(`❌ 處理指令 ${commandName} 時發生錯誤:`, error);
        
        const errorReply = {
            content: '❌ 執行指令時發生錯誤，請稍後再試！',
            ephemeral: true
        };
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorReply);
        } else {
            await interaction.reply(errorReply);
        }
    }
});

// 錯誤處理
client.on('error', error => {
    console.error('❌ Discord.js 錯誤:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ 未處理的 Promise 拒絕:', error);
});

process.on('uncaughtException', error => {
    console.error('❌ 未捕獲的異常:', error);
    process.exit(1);
});

// 啟動機器人
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ 找不到 DISCORD_TOKEN 環境變數！');
    process.exit(1);
}

client.login(token).catch(error => {
    console.error('❌ 機器人登入失敗:', error);
    process.exit(1);
});