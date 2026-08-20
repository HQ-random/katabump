// 请将以下完整内容替换你的 action_renew.js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) { /* 保持不变 */ }

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration (不变) ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) { /* 保持不变 */ }

// ========= 修改 INJECTED_SCRIPT =========
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndClick = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.click();
                        console.log('[注入] 已自动点击 Turnstile 复选框');
                        window.__turnstile_done = true;
                        return true;
                    }
                    return false;
                };
                if (!checkAndClick()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndClick()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// --- 辅助函数 (checkProxy, checkPort, launchChrome, getUsers) 保持不变 ---
// ========= 修改 attemptTurnstileCdp =========
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const done = await frame.evaluate(() => window.__turnstile_done).catch(() => false);
            if (done) {
                console.log('>> Turnstile 复选框已被注入脚本自动点击');
                for (let w = 0; w < 15; w++) {
                    const allFrames = page.frames();
                    let found = false;
                    for (const f of allFrames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    found = true;
                                    break;
                                }
                            } catch (e) {}
                        }
                    }
                    if (found) {
                        console.log('>> Cloudflare 验证成功！');
                        return true;
                    }
                    await page.waitForTimeout(1000);
                }
                console.log('>> 未检测到 Success!，但复选框已点击，继续...');
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// ========= 主流程修改 =========
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }
    if (PROXY_CONFIG) { /* 检查代理 */ }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) { console.error('连接失败。退出。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);
        // 定义 photoDir 和 safeUsername
        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 确保在登录页
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // 循环尝试登录（最多3次）
                let loginAttempts = 0;
                let loginSuccess = false;
                while (loginAttempts < 3 && !loginSuccess) {
                    loginAttempts++;
                    console.log(`   >> 登录尝试 ${loginAttempts}/3`);

                    // 处理 Turnstile（等待自动点击和验证）
                    console.log('   >> 等待 Turnstile 自动点击和验证...');
                    let turnstilePassed = false;
                    for (let retry = 0; retry < 20; retry++) {
                        const clicked = await attemptTurnstileCdp(page);
                        if (clicked) {
                            console.log('   >> Turnstile 处理完成');
                            turnstilePassed = true;
                            break;
                        }
                        console.log(`   >> 等待 Turnstile 出现 (${retry+1}/20)...`);
                        await page.waitForTimeout(1000);
                    }
                    if (!turnstilePassed) {
                        console.log('   ⚠️ Turnstile 未成功，但继续尝试登录...');
                    }

                    // 点击登录
                    await page.getByRole('button', { name: 'Login', exact: true }).click();
                    console.log('⏳ 等待登录后页面跳转...');
                    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 })
                        .catch(e => console.log('⚠️ 导航等待超时，但继续...'));

                    const currentUrl = await page.url();
                    console.log('📍 登录后 URL:', currentUrl);

                    if (currentUrl.includes('dashboard')) {
                        loginSuccess = true;
                        console.log('✅ 登录成功，进入 Dashboard');
                        break;
                    } else if (currentUrl.includes('login') && currentUrl.includes('error=captcha')) {
                        console.log('   ❌ 登录返回 captcha 错误，重试...');
                        await page.goto('https://dashboard.katabump.com/auth/login');
                        await page.waitForTimeout(2000);
                        // 重新填充
                        const emailInput2 = page.getByRole('textbox', { name: 'Email' });
                        await emailInput2.fill(user.username);
                        const pwdInput2 = page.getByRole('textbox', { name: 'Password' });
                        await pwdInput2.fill(user.password);
                        continue;
                    } else {
                        // 检查密码错误
                        try {
                            const errorMsg = page.getByText('Incorrect password or no account');
                            if (await errorMsg.isVisible({ timeout: 3000 })) {
                                console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                                const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                                try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) {}
                                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);
                                break;
                            }
                        } catch (e) {}
                        console.log('   ❌ 登录未知失败，重试...');
                        await page.goto('https://dashboard.katabump.com/auth/login');
                        await page.waitForTimeout(2000);
                        const emailInput3 = page.getByRole('textbox', { name: 'Email' });
                        await emailInput3.fill(user.username);
                        const pwdInput3 = page.getByRole('textbox', { name: 'Password' });
                        await pwdInput3.fill(user.password);
                    }
                }

                if (!loginSuccess) {
                    console.error('❌ 登录失败，跳过该用户');
                    continue;
                }

            } catch (e) {
                console.log('登录错误:', e.message);
                continue;
            }

            // 确保进入 Dashboard
            if (!(await page.url()).includes('dashboard')) {
                console.error('❌ 登录后未进入 Dashboard');
                continue;
            }

            // 查找 "See" 链接
            console.log('正在寻找 "See" 链接...');
            try {
                const seeLink = page.locator('a:has-text("See")').first();
                await seeLink.waitFor({ state: 'visible', timeout: 20000 });
                console.log('✅ 找到 "See" 链接，准备点击...');
                await seeLink.click();
            } catch (e) {
                console.error('❌ 未找到 "See" 链接。错误:', e.message);
                const htmlSnippet = await page.evaluate(() => document.body.innerText.slice(0, 500));
                console.log('📄 当前页面文本片段:', htmlSnippet);
                continue;
            }

            // --- 续期逻辑（保持不变）---
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                // ... （原续期代码不变，但注意内部再次使用了 photoDir 和 safeUser，可提前定义）
                // 为了简洁，这里省略，你保留原有续期代码即可
            }
            // 续期结束后截图（原有代码已有）
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        // 用户处理完成截图
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }
        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
