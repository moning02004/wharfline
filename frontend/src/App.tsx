import { Navigate, Route, Routes } from "react-router-dom";
import { useApp } from "./lib/app";
import { Layout } from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import { Jobs, Runs } from "./pages/Jobs";
import { Inventory, Keys, Registries, Repos } from "./pages/Resources";
import Envs from "./pages/Envs";
import { Activity, Members, Security } from "./pages/Admin";
import Notes from "./pages/Notes";
import Login from "./pages/Login";
import Setup from "./pages/Setup";

export default function App() {
  const { session } = useApp();
  if (!session) return null;
  if (!session.loggedIn) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/registries" element={<Registries />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/keys" element={<Keys />} />
        <Route path="/envs" element={<Envs />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/members" element={<Members />} />
        <Route path="/security" element={<Security />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
