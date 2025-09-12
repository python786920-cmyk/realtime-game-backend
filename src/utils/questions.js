function generateQuestions() {
  const questions = [];
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(Math.random() * 100) + 1;
    const b = Math.floor(Math.random() * 100) + 1;
    const correct = a + b;
    const options = [
      correct,
      correct + Math.floor(Math.random() * 10) + 1,
      correct - Math.floor(Math.random() * 10) - 1,
      correct + Math.floor(Math.random() * 20) - 10
    ];
    questions.push({
      id: i + 1,
      question: `${a} + ${b}`,
      options: options.sort(() => Math.random() - 0.5),
      answer: correct
    });
  }
  return questions;
}

module.exports = { generateQuestions };
