export function showRules(app, el, isAdmin) {
  const section = el("section", undefined, "intro-rules");
  section.setAttribute("aria-labelledby", "rules-heading");
  const heading = el("h2", "カオス小説とは");
  heading.id = "rules-heading";
  section.append(
    heading,
    el("p", "みんなの一節が、一冊の小説になる。", "intro-lead"),
    el(
      "p",
      "前の文章を読み、好きな続きを書く。つながっていても、いなくても。予想できない物語を、一緒につくる場所です。",
    ),
  );
  const rules = [
    [
      "一冊につき、あなたが書けるのは一回だけ。",
      "好きな本に参加できます。別の本には、また書けます。",
    ],
    [
      "まずは、それまでの物語を読もう。",
      "最後のページに進むと、続きを書けるようになります。",
    ],
    [
      "一節は、1〜400文字。",
      "たった一文字でも大丈夫。タイトルや前の展開に合わせる必要はありません。",
    ],
    [
      "投稿した順に、物語がつながる。",
      "書いている間に、誰かの一節が先に入ることもあります。公開した文章は書き直せません。",
    ],
    [
      "決められた文字数に達したら、そこで完結。",
      "短編4,000字、中編12,000字、長編40,000字。文の途中でもおしまいです。最後の投稿は、残りの文字数に収まる部分だけ掲載されます。",
    ],
    [
      "新しい本は、最初の一節と一緒につくる。",
      "タイトルと長さを決めて、あなたが物語を始めてください。最初の一節も、その本への一回分に数えます。",
    ],
    [
      "新しい本をつくれるのは、7日間に一冊。",
      "公開してから7日後に、次の本をつくれます。その間も、ほかの本への参加や下書きはできます。",
    ],
  ];
  const list = el("ol");
  rules.forEach(([title, text], i) => {
    const li = el("li");
    li.append(el("h3", "ルール" + (i + 1) + "：" + title), el("p", text));
    list.append(li);
  });
  section.append(list);
  if (isAdmin)
    section.append(
      el(
        "p",
        "現在は管理者モードのため、投稿・作成回数の制限はありません。",
        "admin-rule-note",
      ),
    );
  app.querySelector(".hero").after(section);
}
