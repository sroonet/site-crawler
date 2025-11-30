const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const crawlJobs = new Map();

function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

app.post('/api/crawl', async (req, res) => {
    const { url, maxPages = 50, maxDepth = 3 } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    let startUrl;
    try { startUrl = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL format' }); }
    const jobId = generateJobId();
    crawlJobs.set(jobId, {
        status: 'running', startUrl: url, startTime: Date.now(), pagesScanned: 0, maxPages, maxDepth,
        results: { pages: [], brokenLinks: [], jsErrors: [], missingImages: [], consoleLogs: [], deadButtons: [], slowPages: [], missingAlt: [], formIssues: [] }
    });
    runCrawl(jobId, startUrl.href, maxPages, maxDepth);
    res.json({ jobId, status: 'started' });
});

app.get('/api/status/:jobId', (req, res) => {
    const job = crawlJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ status: job.status, pagesScanned: job.pagesScanned, maxPages: job.maxPages, elapsedTime: Math.round((Date.now() - job.startTime) / 1000), currentUrl: job.currentUrl || null });
});

app.get('/api/results/:jobId', (req, res) => {
    const job = crawlJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
        status: job.status, startUrl: job.startUrl, pagesScanned: job.pagesScanned, elapsedTime: Math.round((Date.now() - job.startTime) / 1000), results: job.results,
        summary: { totalPages: job.results.pages.length, brokenLinks: job.results.brokenLinks.length, jsErrors: job.results.jsErrors.length, missingImages: job.results.missingImages.length, deadButtons: job.results.deadButtons.length, slowPages: job.results.slowPages.length, missingAlt: job.results.missingAlt.length, formIssues: job.results.formIssues.length }
    });
});

app.post('/api/stop/:jobId', (req, res) => {
    const job = crawlJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = 'stopped';
    res.json({ status: 'stopped' });
});

async function runCrawl(jobId, startUrl, maxPages, maxDepth) {
    const job = crawlJobs.get(jobId);
    if (!job) return;
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu', '--window-size=1920x1080'] });
        const baseUrl = new URL(startUrl);
        const visited = new Set();
        const queue = [{ url: startUrl, depth: 0 }];
        while (queue.length > 0 && job.status === 'running' && visited.size < maxPages) {
            const { url, depth } = queue.shift();
            if (visited.has(url) || depth > maxDepth) continue;
            visited.add(url);
            job.currentUrl = url;
            job.pagesScanned = visited.size;
            try {
                const pageResult = await scanPage(browser, url, baseUrl);
                job.results.pages.push({ url, depth, title: pageResult.title, loadTime: pageResult.loadTime, statusCode: pageResult.statusCode });
                if (pageResult.brokenLinks.length > 0) job.results.brokenLinks.push(...pageResult.brokenLinks.map(link => ({ ...link, foundOn: url })));
                if (pageResult.jsErrors.length > 0) job.results.jsErrors.push(...pageResult.jsErrors.map(err => ({ ...err, foundOn: url })));
                if (pageResult.missingImages.length > 0) job.results.missingImages.push(...pageResult.missingImages.map(img => ({ ...img, foundOn: url })));
                if (pageResult.consoleLogs.length > 0) job.results.consoleLogs.push(...pageResult.consoleLogs.map(log => ({ ...log, foundOn: url })));
                if (pageResult.deadButtons.length > 0) job.results.deadButtons.push(...pageResult.deadButtons.map(btn => ({ ...btn, foundOn: url })));
                if (pageResult.loadTime > 3000) job.results.slowPages.push({ url, loadTime: pageResult.loadTime });
                if (pageResult.missingAlt.length > 0) job.results.missingAlt.push(...pageResult.missingAlt.map(img => ({ ...img, foundOn: url })));
                if (pageResult.formIssues.length > 0) job.results.formIssues.push(...pageResult.formIssues.map(issue => ({ ...issue, foundOn: url })));
                for (const link of pageResult.links) {
                    try { const linkUrl = new URL(link, url); if (linkUrl.hostname === baseUrl.hostname && !visited.has(linkUrl.href)) queue.push({ url: linkUrl.href, depth: depth + 1 }); } catch (e) {}
                }
            } catch (pageError) { job.results.pages.push({ url, depth, error: pageError.message }); }
        }
        job.status = 'complete';
    } catch (error) { job.status = 'error'; job.error = error.message; } finally { if (browser) await browser.close(); }
}

async function scanPage(browser, url, baseUrl) {
    const page = await browser.newPage();
    const result = { title: '', loadTime: 0, statusCode: 200, links: [], brokenLinks: [], jsErrors: [], missingImages: [], consoleLogs: [], deadButtons: [], missingAlt: [], formIssues: [] };
    page.on('console', msg => { const type = msg.type(); if (type === 'error' || type === 'warning') result.consoleLogs.push({ type, text: msg.text() }); });
    page.on('pageerror', error => { result.jsErrors.push({ message: error.message }); });
    try {
        await page.setViewport({ width: 1920, height: 1080 });
        const startTime = Date.now();
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        result.loadTime = Date.now() - startTime;
        result.statusCode = response?.status() || 0;
        result.title = await page.title();
        result.links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')));
        result.missingImages = await page.evaluate(() => { const missing = []; document.querySelectorAll('img').forEach(img => { if (!img.complete || img.naturalWidth === 0) missing.push({ src: img.src, alt: img.alt || '(no alt)' }); }); return missing; });
        result.missingAlt = await page.evaluate(() => { const missing = []; document.querySelectorAll('img').forEach(img => { if (!img.alt || img.alt.trim() === '') missing.push({ src: img.src }); }); return missing; });
        result.deadButtons = await page.evaluate(() => { const dead = []; document.querySelectorAll('a').forEach(a => { const href = a.getAttribute('href'); if (!href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:;') dead.push({ type: 'link', text: a.textContent?.trim().slice(0, 50) || '(empty)', href: href || '(none)' }); }); document.querySelectorAll('button').forEach(btn => { if (!btn.onclick && !btn.type?.match(/submit|reset/) && !btn.closest('form')) { const hasClickListener = btn.getAttribute('onclick') || btn.getAttribute('ng-click') || btn.getAttribute('@click') || btn.getAttribute('v-on:click'); if (!hasClickListener) dead.push({ type: 'button', text: btn.textContent?.trim().slice(0, 50) || '(empty)' }); } }); return dead; });
        result.formIssues = await page.evaluate(() => { const issues = []; document.querySelectorAll('form').forEach((form, index) => { if (!form.action || form.action === window.location.href) issues.push({ form: `Form #${index + 1}`, issue: 'No action attribute' }); if (!form.querySelector('input[type="submit"], button[type="submit"], button:not([type])')) issues.push({ form: `Form #${index + 1}`, issue: 'No submit button' }); }); return issues; });
    } catch (error) { result.jsErrors.push({ message: `Page load error: ${error.message}` }); } finally { await page.close(); }
    return result;
}

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => { console.log(`Site Crawler running on port ${PORT}`); });
