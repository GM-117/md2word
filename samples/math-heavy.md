# 数学公式密集样例

## 有效公式

行内公式：质能方程 $E = mc^2$ 与希腊字母 $\alpha\beta\gamma$。

独立公式（高斯积分）：

$$\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}$$

矩阵：

$$
\begin{pmatrix}
a & b \\
c & d
\end{pmatrix}
$$

## 一个解析失败的公式

下式使用未定义控制序列，pandoc 将按原文输出并产生 warning（预期行为）：

无效公式样例：$\notacommand{x}$

## 公式后文本

公式段落之后应有正常文本。
