# 只改原项目时的补丁说明

如果你不想整包覆盖，只想在原项目里局部修改，按下面 4 处处理。

## 1. 修改默认核心关键词

在前端文件里搜索旧默认词，把默认值改成：

```js
const DEFAULT_KEYWORDS = [
  'power bank',
  'portable charger',
  'power bank with built in cable',
  'fast charging power bank',
  'travel power bank',
  'usb c power bank',
  '10000mah portable charger',
  '20000mah power bank'
].join('\n');
```

并确保：

```js
document.getElementById('keywords').value = DEFAULT_KEYWORDS;
```

## 2. 统一作者与框架来源

在后端或公共配置文件新增：

```js
const REPORT_META = {
  author: 'kong',
  frameworkAttribution: '复刻 Jax 丰哥在跨境写代码的 ASIN 竞品监控报告框架',
  referenceName: 'Jax 丰哥在跨境写代码',
  referenceUrl: '参考链接填原文章链接'
};
```

然后在 HTML、PDF、Markdown、JSON、CSV、ZIP 生成函数里都引用这个对象。

## 3. 修复 PDF 下载

不要让前端直接打开服务器本地路径，也不要返回未生成的 PDF 路径。推荐流程：

```js
app.get('/download/:reportId/:fileName', (req, res) => {
  const filePath = path.join(REPORT_OUTPUT_DIR, req.params.reportId, req.params.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('文件不存在，请重新生成报告。');

  if (req.params.fileName.endsWith('.pdf')) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.fileName)}`);
    return res.sendFile(filePath);
  }

  return res.download(filePath, req.params.fileName);
});
```

## 4. ZIP 也要带来源说明

生成 ZIP 时追加一个说明文件：

```js
archive.append(
  `作者：kong\n框架来源说明：复刻 Jax 丰哥在跨境写代码的 ASIN 竞品监控报告框架\n参考链接：原文章链接\n`,
  { name: 'README_作者与来源说明.txt' }
);
```
