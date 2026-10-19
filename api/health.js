// Vercel Serverless Function：/api/health
// 前端用它判断 AI 是否在线
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: !!process.env.COZE_TOKEN,
    version: 2,
    bots: ['甘龙', '孝公', '邻人'],
    runtime: 'vercel',
  });
};
