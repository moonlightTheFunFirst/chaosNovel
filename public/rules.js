export function showRules(app, el, isAdmin, api) {
  const section = el("section", undefined, "intro-rules");
  section.setAttribute("aria-labelledby", "rules-heading");
  const heading = el("h2", "カオス小説とは");
  heading.id = "rules-heading";
  // Phrase spans keep the lead from breaking in the middle of a word.
  const lead = el("p", undefined, "intro-lead");
  lead.append(el("span", "みんなの一節が、"), el("span", "一冊の小説になる。"));
  const intro = el("div", undefined, "intro-heading");
  intro.append(
    el("div", "HOW IT WORKS", "eyebrow"),
    heading,
    lead,
    el(
      "p",
      "前の文章を読み、好きな続きを書く。つながっていても、いなくても。予想できない物語を、一緒につくる場所です。",
      "intro-text",
    ),
  );
  section.append(intro);
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
  const numerals = ["一", "二", "三", "四", "五", "六", "七"];
  const list = el("ol", undefined, "intro-rule-list");
  rules.forEach(([title, text], i) => {
    const li = el("li");
    const numeral = el("span", numerals[i], "rule-numeral");
    numeral.setAttribute("aria-hidden", "true");
    const body = el("div");
    body.append(el("h3", title), el("p", text));
    li.append(numeral, body);
    list.append(li);
  });
  section.append(list);
  api("/session")
    .then((session) => {
      if (
        session.creation.capacities &&
        !session.creation.capacities.includes(40000)
      )
        intro.append(el("p", "長編は現在、新しくつくれません。", "note"));
    })
    .catch(() => {});
  if (isAdmin)
    intro.append(
      el(
        "p",
        "管理者は一冊への投稿回数・7日間の作成制限が免除されます。執筆中の本の全体上限は管理者にも適用されます。",
        "admin-rule-note",
      ),
    );
  app.querySelector(".hero").after(section);
}
