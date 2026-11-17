import clsx from 'clsx'
import logo from '../../assets/deepstay-logo.png'
import styles from './Logo.module.css'

export const Logo = ({ size = 32, className }: { size?: number; className?: string }) => (
  <span className={clsx(styles.logo, className)} style={{ width: size, height: size }}>
    <img src={logo} alt="deepstay" draggable={false} />
  </span>
)
