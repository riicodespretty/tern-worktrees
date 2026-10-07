# Simplify

Simplify is a Vale style for software documentation. It checks the rules of ASD-STE100 Simplified Technical English (STE), Issue 9.

STE gives each word one meaning. It permits a small set of verb forms. It also sets limits on the length of sentences and paragraphs. With these rules, a reader cannot easily misread an instruction. This style checks the part of STE that a regular expression can find.

For version 2.0.0, use Vale 3.17.1 or a newer version.

## Levels

The style has two levels.

| Level | What it tells you | What to do |
|---|---|---|
| `error` | The alert is almost always correct. | Change the text. For a technical term of your field, see [Keep a technical term](#keep-a-technical-term). |
| `suggestion` | The alert is frequently correct, but not always. | Read the alert, then make a decision. |

No rule uses `warning`. Writers frequently ignore warnings. So each rule is an `error` or a `suggestion`.

### Level policy

A rule is at `error` only when it meets two conditions:

1. A check of its alerts on a corpus of 86 files of engineering text found that 90% or more of the alerts were correct.
2. It gives zero errors on the technical fixture `tests/technical/software.md`.

The other rules are at `suggestion`.

Four rules are at `error` without the first condition:

- `Dictionary` and `UnapprovedWords`: 85% of their error alerts were correct. The headwords with less than 50% correct alerts went to the advisory rules at `suggestion`. See [Generated rules](#generated-rules).
- `GenderNeutral` and `NotesGiveInformation`: the corpus gave no alerts for them, so the check has no figure. Each key names a form that STE does not permit.

Results of the corpus check for the hand-written rules:

| Rule | Level | Correct alerts | Alerts in the sample |
|---|---|---|---|
| `Pronouns` | error | 99% | 75 |
| `LatinAbbreviations` | error | 100% | 15 |
| `AmericanSpelling` | error | 100% | 10 |
| `RestrictedMeanings` | error | 100% | 5 |
| `Semicolons` | error | 98% | 40 |
| `SentenceLengthProcedural` | error | 96% | 27 |
| `Contractions` | error | 94% | 17 |
| `VerbForms` | error | 91% | 39 |
| `SlangAndJargon` | error | 100% | 1 |
| `ParagraphLength` | suggestion | 88% | 16 |
| `SentenceLengthDescriptive` | suggestion | 83% | 40 |
| `PhrasalVerbs` | suggestion | 0% | 2 |

For the results of the generated rules, see [Generated rules](#generated-rules).

## Rules

| Rule | Level | STE rule | What it finds |
|---|---|---|---|
| `Dictionary` | error | 1.1 | An unapproved word. The alert gives the approved word to use. |
| `UnapprovedWords` | error | 1.1 | An unapproved word with no approved word to replace it. Write the sentence again. |
| `Pronouns` | error | 1.1, GR-3 | A pronoun that STE does not approve, for example `whose`, `itself`, or `someone`. |
| `GenderNeutral` | error | 1.1, GR-7 | Words for one gender, for example `he or she`. The alert gives a word for all persons. |
| `LatinAbbreviations` | error | 1.1, GR-6 | A Latin abbreviation, for example `e.g.`, `i.e.`, or `etc.` |
| `SlangAndJargon` | error | 1.10 | Slang, for example `a couple of` or `hack`. |
| `AmericanSpelling` | error | 1.14 | A British spelling. The alert gives the American spelling. |
| `VerbForms` | error | 3.1 to 3.4 | A verb tense that STE does not approve, for example `is running`, `has removed`, or `might`. |
| `Contractions` | error | 4.2 | A contraction, for example `don't`. The fix writes the full words. |
| `SentenceLengthProcedural` | error | 5.1 | An instruction of more than 20 words. |
| `NotesGiveInformation` | error | 5.5 | An instruction in a `NOTE:` block. Put the instruction in a step or a warning. |
| `Semicolons` | error | 8.1 | A semicolon. |
| `RestrictedMeanings` | error | 9.2 | A phrase with a shorter approved form, for example `in order to` or `prior to`. |
| `DictionaryAdvisory` | suggestion | 1.1 | The same as `Dictionary`, for the headwords in `data/advisory-words.yml`. |
| `UnapprovedWordsAdvisory` | suggestion | 1.1 | The same as `UnapprovedWords`, for the headwords in `data/advisory-words.yml`. |
| `PartOfSpeech` | suggestion | 1.2 | A word that STE approves in one part of speech only. Find the word in the dictionary. |
| `NounClusters` | suggestion | 2.1 | A noun cluster of more than three words. |
| `IngForms` | suggestion | 3.5 | An `-ing` word that is not a technical noun or a part of one. |
| `PassiveVoice` | suggestion | 3.6 | A passive verb. In a description, use it only when you do not know who does the action. |
| `Nominalization` | suggestion | 3.7 | An action written as a noun, for example `did a removal of` for `removed`. |
| `OneInstructionPerSentence` | suggestion | 5.2 | Two instructions in one sentence. |
| `ImperativeInstructions` | suggestion | 5.3 | An instruction written as a description, for example `you must`. |
| `SentenceLengthDescriptive` | suggestion | 6.3 | A descriptive sentence of more than 25 words. |
| `ParagraphLength` | suggestion | 6.6 | A paragraph of more than six sentences. |
| `SafetyInstructions` | suggestion | 7.1 to 7.3 | A risk of injury or death in a paragraph with no signal word at the start, for example `WARNING` or `CAUTION`. |
| `PhrasalVerbs` | suggestion | 9.3 | A phrasal verb, for example `carried out` for `did`. |
| `ConjunctionThat` | suggestion | GR-1 | A clause after a verb, for example `make sure` or `show`, with no `that` at its start. |
| `AmbiguousThis` | suggestion | GR-4 | `This` or `These` with no noun after it. |
| `FalseFriends` | suggestion | GR-5 | A false friend, for example `actual` or `comprehensive`. |

## Generated rules

`scripts/build.ts` writes five rules from `data/dictionary.json`. Do not edit these files. Change the data, then run the build again.

| Rule | Level | Entries in 2.0.0 |
|---|---|---|
| `Dictionary` | error | 1,787 |
| `DictionaryAdvisory` | suggestion | 355 |
| `UnapprovedWords` | error | 326 |
| `UnapprovedWordsAdvisory` | suggestion | 7 |
| `PartOfSpeech` | suggestion | 771 |

- The corpus check examined each `Dictionary` and `UnapprovedWords` word in its context.
- The build puts the results of all forms of a headword together. STE gives a meaning to a headword, and a writer changes all of its forms at the same time.
- A headword goes in `data/advisory-words.yml` when less than half of its alerts were correct. The file lists 161 headwords, for example `verify`, `execute`, and `state`.
- The forms of these headwords go to `DictionaryAdvisory` and `UnapprovedWordsAdvisory` at `suggestion`.
- Before this split, 59% of the `Dictionary` alerts and 81% of the `UnapprovedWords` alerts in the sample were correct. After the split, 85% of the 1,899 error alerts on the corpus were correct. The split moved 1,007 alerts to `suggestion`.
- The build stops with an error when a headword in `data/advisory-words.yml` has no row in `data/dictionary.json`.
- The generator skips the technical nouns and technical verbs that Issue 9 lists. They are in `data/ste-technical-terms.yml`.
- A word with an approved use and an unapproved use goes to `PartOfSpeech`. A regular expression cannot see grammar, so this rule is a `suggestion`.

## The Simplify vocabulary

The package includes the vocabulary `Simplify`, in `styles/config/vocabularies/Simplify/accept.txt`. It holds 44 software terms. STE rules flag these terms, but software text uses them as technical nouns or verbs. Examples are `branch`, `caching`, `job`, `log`, `render`, and `test`. The build writes the file from `data/software-terms.yml`. Each entry in that file tells why the term is necessary and gives the evidence.

Add the vocabulary to your `.vale.ini`:

```ini
Vocab = Base, Simplify
```

`Base` is an example. Use the name of your project vocabulary. With `Packages`, the `.vale.ini` of the package adds `Simplify` to `Vocab` automatically.

### Which vocabulary gets a term

- A term of one project goes in the vocabulary of that project. Examples are a product name or the name of a service.
- Do not add a term to the Simplify vocabulary in your project. `vale sync` replaces that directory.
- A term that software text uses in general is a candidate for the Simplify vocabulary. Examples are Git, CI, and HTTP terms. Open an issue or a pull request upstream. Add the term to `data/software-terms.yml` with its `pos`, `forms`, `reason`, and `evidence`.

### The vocabulary and the structural rules

Vale stops an alert when a vocabulary term is anywhere in the match. So the rules that match a structure, not a word, set `vocab: false`. The vocabulary has no effect on these rules: `OneInstructionPerSentence`, `NotesGiveInformation`, `ImperativeInstructions`, `SafetyInstructions`, `VerbForms`, `PassiveVoice`, `AmbiguousThis`, `ConjunctionThat`, and `SentenceLengthProcedural`. `NounClusters` is a `sequence` rule. It cannot set that key, so it uses the vocabulary.

## Keep a technical term

Keep a word when two conditions are true:

- The word is a technical noun or a technical verb of your field.
- The approved word changes the meaning.

Then add one line to the `accept.txt` of your project vocabulary:

```text
[Xx]term(?:s|ed|ing)?
```

- `[Xx]` matches the first letter as a capital letter or as a small letter.
- `(?:s|ed|ing)?` matches the forms of the word. Write only the forms that the word has.
- Example for a noun: `[Ss]hard(?:s)?`.

## Stop a rule

For a part of a file, put comments around the text:

```markdown
<!-- vale Simplify.Dictionary = NO -->
The dialog shows "Delete all items".
<!-- vale Simplify.Dictionary = YES -->
```

For all rules, use `<!-- vale off -->` and `<!-- vale on -->`.

For all files of one type, set the rule to `NO` in `.vale.ini`:

```ini
[*.md]
Simplify.SentenceLengthDescriptive = NO
```

## Known limits

- **Quoted text.** `Dictionary` has no quotation guard. The guard is a lookbehind on each key. On about 1,800 keys, it overflows the backtracking stack of the regexp2 engine. So a `Dictionary` word in quotation marks still gets an alert. Use the comments in [Stop a rule](#stop-a-rule) for that text. The other word rules skip text in straight or curly quotation marks in the same paragraph. They use `scope: paragraph` for this guard.
- **Capital letters.** The word rules do not flag a word in all capital letters, for example `WARNING`, `REST`, or `SHOULD`.
- **Sentence length.** `SentenceLengthProcedural` marks the first word of the sentence. Its message says "more than 20 words" and gives no count, because it is an existence rule. It treats a sentence as an instruction when the sentence starts with a verb. A noun with the same spelling, as in `Build output is written to dist/`, is not an instruction when a form of `be`, `have`, or a modal verb follows it in the next two words.
- **Word count.** STE counts some groups of words as one word. Examples are text in parentheses, text in quotation marks, an identifier, and a number with its unit. The two sentence-length rules approximate that count.
- **Technical terms of Issue 9.** The word rules do not flag the technical nouns and verbs that Issue 9 lists, because the generator skips them.
- **Meaning.** `Dictionary` sees the spelling of a word, not its meaning (rule 1.3). A word in an incorrect meaning gets no alert.
- **Part of speech.** The rules match text, not grammar. So `PartOfSpeech` is a `suggestion`.
- **Structure.** No rule checks the flow of information (rules 6.1, 6.2, 6.4, 6.5, 9.1, and 9.4). A person must check it.
- **Safety.** `SafetyInstructions` reads one paragraph at a time. It sees a signal word only when the signal word is in the same paragraph as the risk.
- **Input.** Vale stops when a file is not in UTF-8.

## Legal notice

<!-- vale off -->
Simplified Technical English, ASD-STE100, is a Copyright and a Trademark of ASD, Brussels, Belgium. This project is neither maintained nor endorsed by ASD. See <https://asd-ste100.org/>.
<!-- vale on -->
