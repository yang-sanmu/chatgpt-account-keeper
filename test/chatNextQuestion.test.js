import test from "node:test";
import assert from "node:assert/strict";
import { extractNextQuestion } from "../src/chat.js";

// 自我追问链条完全依赖从回答末尾抽出"下一个问题"。抽不到就整个对话线程提前
// 结束，抽错就把 Markdown 标记或代码块里的假问题当成真问题发出去。模型的输出
// 格式不稳定（加粗、标题、列表、多余空行都出现过），所以这里把格式变体锁住。

test("基本形式：中文全角冒号", () => {
  assert.equal(
    extractNextQuestion("讲解了索引。\n\n下一个问题：什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("半角冒号同样识别", () => {
  assert.equal(
    extractNextQuestion("讲解了索引。\n下一个问题: 什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("「下一问」简写形式", () => {
  assert.equal(
    extractNextQuestion("内容\n下一问：什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("英文 Next question 形式", () => {
  assert.equal(
    extractNextQuestion("content\n\nNext question: what is a covering index?"),
    "what is a covering index?"
  );
});

test("英文大小写混写也能识别", () => {
  assert.equal(
    extractNextQuestion("content\n\nNEXT QUESTION: what next?"),
    "what next?"
  );
});

test("前缀被加粗时不把 ** 带进问题", () => {
  // 模型最常见的输出格式，之前会得到 "**什么是覆盖索引？"。
  assert.equal(
    extractNextQuestion("内容\n\n**下一个问题：**什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("整行被加粗时不把结尾的 ** 带进问题", () => {
  assert.equal(
    extractNextQuestion("内容\n\n**下一个问题：什么是覆盖索引？**"),
    "什么是覆盖索引？"
  );
});

test("单星号强调同样被剥掉", () => {
  assert.equal(
    extractNextQuestion("内容\n\n*下一个问题：*什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("下划线强调被剥掉", () => {
  assert.equal(
    extractNextQuestion("内容\n\n_下一个问题：_什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
  assert.equal(
    extractNextQuestion("内容\n\n__下一个问题：什么是覆盖索引？__"),
    "什么是覆盖索引？"
  );
});

test("强调标记与引号叠加时逐层剥净", () => {
  // 模型会同时用加粗和引号包裹，单趟剥离只能去掉最外层。
  assert.equal(
    extractNextQuestion("内容\n下一个问题：**「什么是覆盖索引？」**"),
    "什么是覆盖索引？"
  );
  assert.equal(
    extractNextQuestion('内容\n下一个问题：*"什么是覆盖索引？"*'),
    "什么是覆盖索引？"
  );
});

test("引号在外强调在内时也要剥净", () => {
  // 这个顺序单趟剥不掉：先去掉引号后，露出来的 ** 需要再来一趟。
  assert.equal(
    extractNextQuestion("内容\n下一个问题：「**什么是覆盖索引？**」"),
    "什么是覆盖索引？"
  );
  assert.equal(
    extractNextQuestion('内容\n下一个问题："**什么是覆盖索引？**"'),
    "什么是覆盖索引？"
  );
});

test("嵌套引号被逐层剥掉", () => {
  assert.equal(
    extractNextQuestion("内容\n下一个问题：「「什么是覆盖索引？」」"),
    "什么是覆盖索引？"
  );
});

test("末尾出现空前缀时不覆盖前面已抽到的问题", () => {
  // 模型有时先给出真问题，末尾又留一个空的模板前缀。空的那个不该把真问题冲掉。
  assert.equal(
    extractNextQuestion("内容\n下一个问题：什么是覆盖索引？\n\n下一个问题：\n"),
    "什么是覆盖索引？"
  );
});

test("末尾只剩标记符号的前缀同样不覆盖真问题", () => {
  assert.equal(
    extractNextQuestion("内容\n下一个问题：什么是覆盖索引？\n\n**下一个问题：**"),
    "什么是覆盖索引？"
  );
});

test("Markdown 标题前缀", () => {
  assert.equal(
    extractNextQuestion("内容\n\n### 下一个问题：什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("列表项前缀", () => {
  assert.equal(
    extractNextQuestion("内容\n\n- 下一个问题：什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("引用块前缀", () => {
  assert.equal(
    extractNextQuestion("内容\n\n> 下一个问题：什么是覆盖索引？"),
    "什么是覆盖索引？"
  );
});

test("尾随空行不影响抽取", () => {
  assert.equal(
    extractNextQuestion("内容\n\n下一个问题：什么是覆盖索引？\n\n   \n"),
    "什么是覆盖索引？"
  );
});

test("问题后面还有客套话时仍取到问题本身", () => {
  assert.equal(
    extractNextQuestion("内容\n下一个问题：什么是覆盖索引？\n希望对你有帮助。"),
    "什么是覆盖索引？"
  );
});

test("多次出现时取最后一个", () => {
  // 多轮对话里模型可能复述上一轮的问题，最后一个才是本轮真正的追问。
  assert.equal(
    extractNextQuestion(
      "上轮我问过 下一个问题：旧问题？\n\n新的讲解\n\n下一个问题：新问题？"
    ),
    "新问题？"
  );
});

test("成对引号被剥掉", () => {
  assert.equal(
    extractNextQuestion("内容\n下一个问题：「什么是覆盖索引？」"),
    "什么是覆盖索引？"
  );
});

test("英文成对引号被剥掉", () => {
  assert.equal(
    extractNextQuestion('内容\n下一个问题："什么是覆盖索引？"'),
    "什么是覆盖索引？"
  );
});

test("代码块里的示例前缀不被当成真问题", () => {
  // 讲解 Markdown 或 prompt 工程时模型会把模板写进代码块。照抄进去会让
  // 下一轮问出一个跟主题无关的假问题。
  assert.equal(
    extractNextQuestion("演示模板：\n```\n下一个问题：这里是占位符\n```"),
    null
  );
});

test("代码块之后的真实问题仍能抽到", () => {
  assert.equal(
    extractNextQuestion(
      "演示模板：\n```\n下一个问题：占位符\n```\n\n下一个问题：真正的问题？"
    ),
    "真正的问题？"
  );
});

test("波浪线代码块里的示例前缀不被当成真问题", () => {
  assert.equal(
    extractNextQuestion("演示模板：\n~~~text\n下一个问题：这里是占位符\n~~~"),
    null
  );
});

test("行内代码里的前缀不被当成真问题", () => {
  assert.equal(
    extractNextQuestion("用 `下一个问题：` 开头即可。"),
    null
  );
  assert.equal(
    extractNextQuestion("用 ``下一个问题：占位符`` 演示。"),
    null
  );
});

test("冒号后为空时返回 null 而不是空串", () => {
  // 空串是 falsy，但只有空格时之前返回 ""，仍会被当成"抽到了问题"送去发送。
  assert.equal(extractNextQuestion("内容\n下一个问题："), null);
  assert.equal(extractNextQuestion("内容\n下一个问题：   "), null);
  assert.equal(extractNextQuestion("内容\n下一个问题：\n"), null);
});

test("只剩标记符号时返回 null", () => {
  assert.equal(extractNextQuestion("内容\n下一个问题：**"), null);
  assert.equal(extractNextQuestion("内容\n下一个问题：「」"), null);
});

test("没有前缀时返回 null", () => {
  assert.equal(extractNextQuestion("一段完全没有追问的回答。"), null);
});

test("空输入返回 null", () => {
  assert.equal(extractNextQuestion(null), null);
  assert.equal(extractNextQuestion(undefined), null);
  assert.equal(extractNextQuestion(""), null);
  assert.equal(extractNextQuestion("   \n  "), null);
});

test("非字符串输入不抛异常", () => {
  assert.equal(extractNextQuestion(42), null);
  assert.equal(extractNextQuestion({}), null);
  assert.equal(extractNextQuestion([]), null);
});

test("跨行的问题只取首行，不把整段解释吞进来", () => {
  const extracted = extractNextQuestion(
    "内容\n下一个问题：什么是覆盖索引？\n\n（提示：想想回表。）"
  );
  assert.equal(extracted, "什么是覆盖索引？");
});

test("超长问题被截断到可用长度且不带省略号污染", () => {
  const long = "字".repeat(1000);
  const extracted = extractNextQuestion(`内容\n下一个问题：${long}`);
  assert.ok(extracted.length <= 500, `实际长度 ${extracted.length}`);
  assert.ok(extracted.startsWith("字字字"));
});
