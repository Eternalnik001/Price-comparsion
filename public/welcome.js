const getName = () => {
  // Try to get name from localStorage first
  let name = localStorage.getItem('userName');
  if (name) return name;

  // If not in localStorage, ask the user
  name = prompt("Welcome to PriceScope! What's your name?");
  if (name && name.trim().length > 0) {
    localStorage.setItem('userName', name.trim());
    return name.trim();
  }
  return 'Guest';
};

document.addEventListener('DOMContentLoaded', () => {
  const userName = getName();
  const welcomeEl = document.getElementById('welcomeMessage');
  if (welcomeEl) {
    welcomeEl.textContent = `WELCOME ${userName.toUpperCase()}`;
  }
});
